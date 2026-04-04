import type { AgentMemoryStore, MemoryEntry } from '../../runtime/agent-memory-store.js';
import type { ConversationService } from '../../runtime/conversation.js';
import type { PersistMemoryEntryResult } from '../../runtime/memory-mutation-service.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

type PersistentMemorySearchMatch = {
  id: string;
  createdAt: string;
  category?: string;
  summary?: string;
  content: string;
  trustLevel?: string;
  status?: string;
  tags?: string[];
  provenance?: Record<string, unknown>;
  matchScore: number;
};

type ConversationMemorySearchCandidate = {
  key: string;
  source: 'conversation';
  type: 'conversation_message';
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  channel: string;
  sessionId: string;
  scoreHint: number;
};

type PersistentMemorySearchCandidate = {
  key: string;
  source: 'global' | 'code_session';
  type: 'memory_entry';
  entryId: string;
  createdAt: string;
  category?: string;
  summary?: string;
  content: string;
  trustLevel?: string;
  status?: string;
  tags?: string[];
  provenance?: Record<string, unknown>;
  scoreHint: number;
};

type UnifiedMemorySearchCandidate = ConversationMemorySearchCandidate | PersistentMemorySearchCandidate;

type PersistentMemoryContextTarget = {
  source: 'global' | 'code_session';
  id: string;
  store?: AgentMemoryStore;
  guardPath: string;
};

interface MemoryToolRegistrarContext {
  registry: ToolRegistry;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  conversationService?: ConversationService;
  resolveStateAgentId?: (agentId?: string) => string | undefined;
  normalizeMemorySearchScope: (input: unknown) => 'conversation' | 'persistent' | 'both' | null;
  normalizePersistentMemoryScope: (
    input: unknown,
    request?: Partial<ToolExecutionRequest>,
    fallbackScope?: 'global' | 'code_session' | 'both',
  ) => 'global' | 'code_session' | 'both' | null;
  normalizeMemoryMutationScope: (input: unknown) => 'global' | 'code_session' | null;
  resolvePersistentMemoryContexts: (
    targetScope: 'global' | 'code_session' | 'both',
    sessionId: string | undefined,
    request?: Partial<ToolExecutionRequest>,
    explicitGlobalAgentId?: string,
  ) => { contexts: PersistentMemoryContextTarget[]; error?: string };
  searchPersistentMemoryEntries: (
    store: AgentMemoryStore,
    targetId: string,
    query: string,
    limit: number,
  ) => PersistentMemorySearchMatch[];
  fuseRankedMemorySearchResults: (
    sources: UnifiedMemorySearchCandidate[][],
    limit: number,
  ) => Array<UnifiedMemorySearchCandidate & { score: number; rank: number }>;
  getGlobalMemoryContext: (
    request?: Partial<ToolExecutionRequest>,
    explicitAgentId?: string,
  ) => { agentId: string; store?: AgentMemoryStore };
  resolveCodeSessionMemoryContext: (
    sessionId: string | undefined,
    request?: Partial<ToolExecutionRequest>,
  ) => { sessionId: string; store?: AgentMemoryStore } | null;
  getMemoryMutationReadOnlyError: (
    args?: Record<string, unknown>,
    request?: Partial<ToolExecutionRequest>,
  ) => string | null;
  persistMemoryEntry?: (input: {
    target: {
      scope: 'global' | 'code_session';
      scopeId: string;
      store: AgentMemoryStore;
      auditAgentId: string;
    };
    intent: 'assistant_save' | 'context_flush';
    entry: MemoryEntry;
    actor?: string;
    runMaintenance?: boolean;
  }) => PersistMemoryEntryResult;
}

export function registerBuiltinMemoryTools(context: MemoryToolRegistrarContext): void {
  const { asString, asNumber } = context;

  context.registry.register(
    {
      name: 'memory_search',
      description: 'Search conversation history, persistent memory, or both. Conversation results use FTS5 BM25 ranking when available; persistent-memory results use deterministic field-aware ranking. In Code sessions, persistent search defaults to both global and code-session memory unless persistentScope is set.',
      shortDescription: 'Search conversation history and persistent memory.',
      risk: 'read_only',
      category: 'memory',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (words, phrases). Supports FTS5 syntax when available.' },
          scope: {
            type: 'string',
            enum: ['conversation', 'persistent', 'both'],
            description: 'Which memory surface to search. Defaults to both.',
          },
          persistentScope: {
            type: 'string',
            enum: ['global', 'code_session', 'both'],
            description: 'Which persistent memory scope to search when scope includes persistent memory. Defaults to global outside Code and both inside Code.',
          },
          sessionId: {
            type: 'string',
            description: 'Required when persistentScope includes code_session and the current request is not already attached to that coding session.',
          },
          limit: { type: 'number', description: 'Maximum results to return (default: 10, max: 50).' },
        },
        required: ['query'],
      },
    },
    async (args, request) => {
      const query = asString(args.query).trim();
      if (!query) return { success: false, error: 'Query is required.' };
      const scope = context.normalizeMemorySearchScope(args.scope);
      if (!scope) {
        return { success: false, error: 'scope must be one of "conversation", "persistent", or "both".' };
      }
      const persistentScope = context.normalizePersistentMemoryScope(args.persistentScope, request);
      if (!persistentScope) {
        return { success: false, error: 'persistentScope must be one of "global", "code_session", or "both".' };
      }
      const persistentSessionId = asString(args.sessionId).trim() || undefined;

      const conversationService = context.conversationService;
      const limit = Math.min(Math.max(asNumber(args.limit, 10), 1), 50);
      const searchConversation = scope === 'conversation' || scope === 'both';
      const searchPersistent = scope === 'persistent' || scope === 'both';
      const requestAgentId = asString(request.agentId);
      const stateAgentId = context.resolveStateAgentId?.(requestAgentId) ?? requestAgentId;

      const conversationRanked: ConversationMemorySearchCandidate[] = [];
      if (searchConversation && conversationService) {
        context.guardAction(request, 'read_file', { path: 'memory:conversation_search', query });
        const results = conversationService.searchMessages(query, {
          userId: asString(request.userId),
          agentId: stateAgentId,
          limit: Math.min(limit * 2, 100),
        });
        results.forEach((row, index) => {
          conversationRanked.push({
            key: `conversation:${row.sessionId}:${row.timestamp}:${row.role}:${index}`,
            source: 'conversation',
            type: 'conversation_message',
            role: row.role,
            content: row.content.length > 500 ? `${row.content.slice(0, 500)}...` : row.content,
            timestamp: row.timestamp,
            channel: row.channel,
            sessionId: row.sessionId,
            scoreHint: row.score,
          });
        });
      }

      const persistentRanked: PersistentMemorySearchCandidate[] = [];
      const searchedPersistentScopes: Array<'global' | 'code_session'> = [];
      if (searchPersistent) {
        const resolvedPersistent = context.resolvePersistentMemoryContexts(persistentScope, persistentSessionId, request);
        if (resolvedPersistent.error) {
          return { success: false, error: resolvedPersistent.error };
        }
        for (const persistentContext of resolvedPersistent.contexts) {
          if (!persistentContext.store) continue;
          searchedPersistentScopes.push(persistentContext.source);
          context.guardAction(request, 'read_file', { path: persistentContext.guardPath, query });
          const results = context.searchPersistentMemoryEntries(
            persistentContext.store,
            persistentContext.id,
            query,
            Math.min(limit * 2, 100),
          );
          results.forEach((entry) => {
            persistentRanked.push({
              key: `${persistentContext.source}:${entry.id}`,
              source: persistentContext.source,
              type: 'memory_entry',
              entryId: entry.id,
              createdAt: entry.createdAt,
              category: entry.category,
              summary: entry.summary,
              content: entry.content,
              trustLevel: entry.trustLevel,
              status: entry.status,
              tags: entry.tags,
              provenance: entry.provenance,
              scoreHint: entry.matchScore,
            });
          });
        }
      }

      if (scope === 'conversation' && !conversationService) {
        return { success: false, error: 'Conversation memory is not enabled.' };
      }
      if (scope === 'persistent' && searchedPersistentScopes.length === 0) {
        return { success: false, error: 'Persistent memory is not enabled.' };
      }

      const fusedResults = context.fuseRankedMemorySearchResults(
        [
          ...(searchConversation ? [conversationRanked] : []),
          ...(searchPersistent ? [persistentRanked] : []),
        ],
        limit,
      );

      return {
        success: true,
        output: {
          query,
          scope,
          hasFTS: conversationService?.hasFTS ?? false,
          currentPersistentScope: 'global',
          persistentScopesSearched: searchedPersistentScopes,
          resultCount: fusedResults.length,
          results: fusedResults.map((result) => ({
            rank: result.rank,
            score: result.score,
            source: result.source,
            type: result.type,
            content: result.content,
            ...(result.type === 'conversation_message'
              ? {
                role: result.role,
                timestamp: result.timestamp,
                channel: result.channel,
                sessionId: result.sessionId,
                sourceScore: result.scoreHint,
              }
              : {
                entryId: result.entryId,
                createdAt: result.createdAt,
                category: result.category,
                summary: result.summary,
                trustLevel: result.trustLevel,
                status: result.status,
                tags: result.tags,
                provenance: result.provenance,
                sourceScore: result.scoreHint,
              }),
          })),
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'memory_recall',
      description: 'Retrieve persistent long-term memory. Global memory remains the primary scope. Code-session memory is available explicitly as session-local augment memory.',
      shortDescription: 'Retrieve global or code-session persistent memory.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent ID to retrieve knowledge base for (defaults to current agent).' },
          scope: {
            type: 'string',
            enum: ['global', 'code_session', 'both'],
            description: 'Which persistent memory scope to retrieve. Defaults to global.',
          },
          sessionId: {
            type: 'string',
            description: 'Required when scope includes code_session and the current request is not already attached to that coding session.',
          },
        },
      },
    },
    async (args, request) => {
      const scope = context.normalizePersistentMemoryScope(args.scope, request, 'global');
      if (!scope) {
        return { success: false, error: 'scope must be one of "global", "code_session", or "both".' };
      }
      const resolved = context.resolvePersistentMemoryContexts(scope, asString(args.sessionId), request, asString(args.agentId));
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }

      const outputs: Array<{
        scope: 'global' | 'code_session';
        agentId?: string;
        codeSessionId?: string;
        exists: boolean;
        sizeChars: number;
        entries: Array<{
          id: string;
          createdAt: string;
          category?: string;
          summary?: string;
          content: string;
          trustLevel?: string;
          status?: string;
        }>;
        content: string;
      }> = [];

      for (const memoryContext of resolved.contexts) {
        context.guardAction(request, 'read_file', { path: memoryContext.guardPath });
        if (!memoryContext.store) {
          return {
            success: false,
            error: memoryContext.source === 'global'
              ? 'Knowledge base is not enabled.'
              : 'Code-session memory is not enabled.',
          };
        }
        const content = memoryContext.store.load(memoryContext.id);
        outputs.push({
          scope: memoryContext.source,
          ...(memoryContext.source === 'global' ? { agentId: memoryContext.id } : { codeSessionId: memoryContext.id }),
          exists: memoryContext.store.exists(memoryContext.id),
          sizeChars: memoryContext.store.size(memoryContext.id),
          entries: memoryContext.store.getEntries(memoryContext.id).map((entry) => ({
            id: entry.id,
            createdAt: entry.createdAt,
            category: entry.category,
            summary: entry.summary,
            content: entry.content,
            trustLevel: entry.trustLevel,
            status: entry.status,
          })),
          content: content || (memoryContext.source === 'global'
            ? '(empty — no memories stored yet)'
            : '(empty — no coding memories stored yet)'),
        });
      }

      if (scope === 'both') {
        return {
          success: true,
          output: {
            scope: 'both',
            global: outputs.find((entry) => entry.scope === 'global') ?? null,
            codeSession: outputs.find((entry) => entry.scope === 'code_session') ?? null,
          },
        };
      }

      return {
        success: true,
        output: outputs[0],
      };
    },
  );

  context.registry.register(
    {
      name: 'memory_save',
      description: 'Save a fact, preference, decision, or summary to persistent long-term memory. Global memory is the default target. Use scope=code_session for session-local coding memory.',
      shortDescription: 'Save a fact or summary to global or code-session memory.',
      risk: 'mutating',
      category: 'memory',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact, preference, or summary to remember.' },
          summary: { type: 'string', description: 'Optional short gist used when memory is packed back into prompt context.' },
          category: { type: 'string', description: 'Optional category heading (e.g., "Preferences", "Decisions", "Facts", "Project Notes").' },
          scope: {
            type: 'string',
            enum: ['global', 'code_session'],
            description: 'Which persistent memory scope to write. Defaults to global.',
          },
          sessionId: {
            type: 'string',
            description: 'Required when scope=code_session and the current request is not already attached to that coding session.',
          },
        },
        required: ['content'],
      },
    },
    async (args, request) => {
      const content = asString(args.content).trim();
      if (!content) return { success: false, error: 'Content is required.' };
      const summary = asString(args.summary).trim() || undefined;
      const category = asString(args.category).trim() || undefined;
      const targetScope = context.normalizeMemoryMutationScope(args.scope);
      if (!targetScope) {
        return { success: false, error: 'scope must be one of "global" or "code_session".' };
      }
      const readOnlyError = context.getMemoryMutationReadOnlyError(args, request);
      if (readOnlyError) {
        return { success: false, error: readOnlyError };
      }
      const requestTrustLevel = request.contentTrustLevel ?? 'trusted';
      const trustLevel = requestTrustLevel === 'trusted' ? 'trusted' : 'untrusted';
      const status = requestTrustLevel === 'trusted' && !request.derivedFromTaintedContent
        ? 'active'
        : 'quarantined';

      if (targetScope === 'code_session') {
        const codeMemory = context.resolveCodeSessionMemoryContext(asString(args.sessionId), request);
        if (!codeMemory) {
          return { success: false, error: 'A reachable code session is required to save code-session memory.' };
        }
        context.guardAction(request, 'write_file', { path: `memory:code_session:${codeMemory.sessionId}`, content });
        if (!codeMemory.store) {
          return { success: false, error: 'Code-session memory is not enabled.' };
        }
        const writeInput: MemoryEntry = {
          content,
          summary,
          createdAt: new Date().toISOString().slice(0, 10),
          category,
          sourceType: requestTrustLevel === 'trusted' ? 'user' : 'remote_tool',
          trustLevel,
          status,
          createdByPrincipal: request.principalId ?? request.userId,
          provenance: {
            sessionId: codeMemory.sessionId,
            taintReasons: request.taintReasons,
          },
        };
        const stored = context.persistMemoryEntry
          ? context.persistMemoryEntry({
            target: {
              scope: 'code_session',
              scopeId: codeMemory.sessionId,
              store: codeMemory.store,
              auditAgentId: asString(request.agentId) || 'default',
            },
            intent: 'assistant_save',
            entry: writeInput,
            actor: request.principalId ?? request.userId,
          })
          : {
            action: 'created' as const,
            reason: 'new_entry' as const,
            entry: codeMemory.store.append(codeMemory.sessionId, writeInput),
          };

        return {
          success: true,
          output: {
            scope: 'code_session',
            codeSessionId: codeMemory.sessionId,
            entryId: stored.entry.id,
            saved: content,
            summary: stored.entry.summary,
            category: category ?? '(uncategorized)',
            status: stored.entry.status,
            trustLevel: stored.entry.trustLevel,
            action: stored.action,
            dedupeReason: stored.reason,
            matchedEntryId: stored.matchedEntryId,
            totalSizeChars: codeMemory.store.size(codeMemory.sessionId),
          },
          verificationStatus: codeMemory.store.isEntryActive(codeMemory.sessionId, stored.entry.id) ? 'verified' : 'unverified',
          verificationEvidence: codeMemory.store.isEntryActive(codeMemory.sessionId, stored.entry.id)
            ? `Code-session memory entry ${stored.entry.id} is active (${stored.action}).`
            : `Code-session memory entry ${stored.entry.id} was persisted as ${stored.entry.status}.`,
        };
      }

      context.guardAction(request, 'write_file', { path: 'memory:knowledge_base', content });

      const globalMemory = context.getGlobalMemoryContext(request);
      if (!globalMemory.store) {
        return { success: false, error: 'Knowledge base is not enabled.' };
      }

      const writeInput: MemoryEntry = {
        content,
        summary,
        createdAt: new Date().toISOString().slice(0, 10),
        category,
        sourceType: requestTrustLevel === 'trusted' ? 'user' : 'remote_tool',
        trustLevel,
        status,
        createdByPrincipal: request.principalId ?? request.userId,
        provenance: {
          sessionId: request.scheduleId,
          taintReasons: request.taintReasons,
        },
      };
      const stored = context.persistMemoryEntry
        ? context.persistMemoryEntry({
          target: {
            scope: 'global',
            scopeId: globalMemory.agentId,
            store: globalMemory.store,
            auditAgentId: globalMemory.agentId,
          },
          intent: 'assistant_save',
          entry: writeInput,
          actor: request.principalId ?? request.userId,
        })
        : {
          action: 'created' as const,
          reason: 'new_entry' as const,
          entry: globalMemory.store.append(globalMemory.agentId, writeInput),
        };

      return {
        success: true,
        output: {
          scope: 'global',
          agentId: globalMemory.agentId,
          entryId: stored.entry.id,
          saved: content,
          summary: stored.entry.summary,
          category: category ?? '(uncategorized)',
          status: stored.entry.status,
          trustLevel: stored.entry.trustLevel,
          action: stored.action,
          dedupeReason: stored.reason,
          matchedEntryId: stored.matchedEntryId,
          totalSizeChars: globalMemory.store.size(globalMemory.agentId),
        },
        verificationStatus: globalMemory.store.isEntryActive(globalMemory.agentId, stored.entry.id) ? 'verified' : 'unverified',
        verificationEvidence: globalMemory.store.isEntryActive(globalMemory.agentId, stored.entry.id)
          ? `Memory entry ${stored.entry.id} is active in the knowledge base (${stored.action}).`
          : `Memory entry ${stored.entry.id} was persisted as ${stored.entry.status}.`,
      };
    },
  );

  context.registry.register(
    {
      name: 'memory_bridge_search',
      description: 'Read-only search across the other persistent memory scope. Use this to search global memory from a Code session, or to search a Code-session memory from outside it, without changing the current context or objective.',
      shortDescription: 'Read-only search across another persistent memory scope.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          targetScope: {
            type: 'string',
            enum: ['global', 'code_session'],
            description: 'Which persistent memory scope to search.',
          },
          query: { type: 'string', description: 'The text to search for.' },
          sessionId: { type: 'string', description: 'Required when searching a specific code-session memory from outside that session.' },
          limit: { type: 'number', description: 'Maximum number of results to return (default 10).' },
        },
        required: ['targetScope', 'query'],
      },
    },
    async (args, request) => {
      const targetScope = asString(args.targetScope).trim().toLowerCase();
      const query = asString(args.query).trim();
      if (targetScope !== 'global' && targetScope !== 'code_session') {
        return { success: false, error: 'targetScope must be "global" or "code_session".' };
      }
      if (!query) {
        return { success: false, error: 'Query is required.' };
      }

      const limit = Math.min(Math.max(asNumber(args.limit, 10), 1), 20);

      if (targetScope === 'global') {
        context.guardAction(request, 'read_file', { path: 'memory:bridge:global', query });
        const globalMemory = context.getGlobalMemoryContext(request);
        if (!globalMemory.store) {
          return { success: false, error: 'Knowledge base is not enabled.' };
        }
        const results = context.searchPersistentMemoryEntries(globalMemory.store, globalMemory.agentId, query, limit);
        return {
          success: true,
          output: {
            referenceOnly: true,
            sourceScope: 'global',
            agentId: globalMemory.agentId,
            query,
            resultCount: results.length,
            results,
          },
          message: results.length > 0
            ? `Found ${results.length} reference memory entr${results.length === 1 ? 'y' : 'ies'} in global memory.`
            : 'No matching entries found in global memory.',
        };
      }

      const codeMemory = context.resolveCodeSessionMemoryContext(asString(args.sessionId), request);
      if (!codeMemory) {
        return { success: false, error: 'A reachable code session is required to search code-session memory.' };
      }
      context.guardAction(request, 'read_file', { path: `memory:bridge:code_session:${codeMemory.sessionId}`, query });
      if (!codeMemory.store) {
        return { success: false, error: 'Code-session memory is not enabled.' };
      }
      const results = context.searchPersistentMemoryEntries(codeMemory.store, codeMemory.sessionId, query, limit);
      return {
        success: true,
        output: {
          referenceOnly: true,
          sourceScope: 'code_session',
          codeSessionId: codeMemory.sessionId,
          query,
          resultCount: results.length,
          results,
        },
        message: results.length > 0
          ? `Found ${results.length} reference memory entr${results.length === 1 ? 'y' : 'ies'} in code-session memory.`
          : 'No matching entries found in code-session memory.',
      };
    },
  );
}
