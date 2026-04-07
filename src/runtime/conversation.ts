/**
 * Conversation memory service with SQLite persistence and session controls.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage } from '../llm/types.js';
import { SQLiteSecurityMonitor, type SQLiteSecurityEvent } from './sqlite-security.js';
import type { ResponseSourceMetadata } from './model-routing-ux.js';
import {
  hasSQLiteDriver,
  openSQLiteDatabase,
  type SQLiteDatabase,
  type SQLiteStatement,
} from './sqlite-driver.js';

/** Unique key for a single conversation thread. */
export interface ConversationKey {
  agentId: string;
  userId: string;
  channel: string;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  responseSource?: ResponseSourceMetadata;
}

/** Result from full-text search across conversation history. */
export interface ConversationSearchResult {
  /** BM25 relevance score (lower = more relevant in SQLite FTS5). */
  score: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  agentId: string;
  userId: string;
  channel: string;
  sessionId: string;
}

interface FTSSearchRow {
  score: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  agent_id: string;
  user_id: string;
  channel: string;
  session_id: string;
}

interface SessionRow {
  session_id: string;
}

interface CountRow {
  count: number;
}

interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  response_source_json: string | null;
}

interface SessionSummaryRow {
  session_id: string;
  message_count: number;
  last_message_at: number;
}

export interface ConversationSessionInfo {
  sessionId: string;
  messageCount: number;
  lastMessageAt: number;
  isActive: boolean;
}

export interface ConversationContextQuery {
  text?: string;
  focusTexts?: string[];
  tags?: string[];
  identifiers?: string[];
}

export interface ConversationContextOptions {
  query?: string | ConversationContextQuery;
}

interface NormalizedConversationContextQuery {
  text?: string;
  focusTexts: string[];
  tags: string[];
  identifiers: string[];
  terms: string[];
}

interface TrimmedHistorySelection {
  entries: ConversationEntry[];
  cutoffIndex: number;
}

function normalizeContextText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function uniqueNormalized(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const next = normalizeContextText(typeof value === 'string' ? value : '');
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function extractQueryTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    for (const term of value.split(/[^a-z0-9]+/).filter((candidate) => candidate.length >= 2)) {
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

function normalizeConversationContextQuery(
  query: string | ConversationContextQuery | undefined,
): NormalizedConversationContextQuery | null {
  if (typeof query === 'string') {
    const text = normalizeContextText(query);
    if (!text) return null;
    return { text, focusTexts: [], tags: [], identifiers: [], terms: extractQueryTerms([text]) };
  }
  if (!query) return null;
  const text = normalizeContextText(query.text);
  const focusTexts = uniqueNormalized(query.focusTexts);
  const tags = uniqueNormalized(query.tags);
  const identifiers = uniqueNormalized(query.identifiers);
  const terms = extractQueryTerms([...(text ? [text] : []), ...focusTexts, ...tags, ...identifiers]);
  if (!text && focusTexts.length === 0 && tags.length === 0 && identifiers.length === 0 && terms.length === 0) {
    return null;
  }
  return {
    ...(text ? { text } : {}),
    focusTexts,
    tags,
    identifiers,
    terms,
  };
}

function scoreConversationEntry(
  entry: ConversationEntry,
  index: number,
  total: number,
  query: NormalizedConversationContextQuery | null,
): number {
  const content = normalizeContextText(entry.content);
  let score = Math.round(((index + 1) / Math.max(1, total)) * 40);
  if (entry.role === 'user') score += 12;
  if (!query || !content) return score;
  if (query.text && content.includes(query.text)) score += 140;
  for (const focusText of query.focusTexts) {
    if (content.includes(focusText)) score += 90;
  }
  for (const identifier of query.identifiers) {
    if (content.includes(identifier)) score += 100;
  }
  for (const tag of query.tags) {
    if (content.includes(tag)) score += 50;
  }
  for (const term of query.terms) {
    if (content.includes(term)) score += 12;
  }
  return score;
}

function selectContiguousHistoryWindow(
  history: ConversationEntry[],
  maxChars: number,
  query: NormalizedConversationContextQuery | null,
): TrimmedHistorySelection {
  let bestStart = history.length;
  let bestScore = Number.NEGATIVE_INFINITY;
  let found = false;
  for (let start = history.length - 1; start >= 0; start -= 1) {
    const suffix = history.slice(start);
    const chars = suffix.reduce((sum, entry) => sum + entry.content.length, 0);
    if (chars > maxChars) continue;
    found = true;
    const score = suffix.reduce((sum, entry, offset) => (
      sum + scoreConversationEntry(entry, start + offset, history.length, query)
    ), 0) - Math.round(chars / 64);
    if (score >= bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  if (!found) {
    const last = history[history.length - 1];
    return {
      entries: last ? [last] : [],
      cutoffIndex: Math.max(-1, history.length - 2),
    };
  }
  return {
    entries: history.slice(bestStart),
    cutoffIndex: bestStart - 1,
  };
}

function selectRecentHistoryWindow(history: ConversationEntry[], maxChars: number): TrimmedHistorySelection {
  const reversed: ConversationEntry[] = [];
  let totalChars = 0;
  let cutoffIndex = -1;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const nextTotal = totalChars + entry.content.length;
    if (nextTotal > maxChars) {
      cutoffIndex = i;
      break;
    }
    reversed.push(entry);
    totalChars = nextTotal;
  }

  return {
    entries: reversed.reverse(),
    cutoffIndex,
  };
}

function trimHistoryForContext(
  history: ConversationEntry[],
  maxChars: number,
  query: string | ConversationContextQuery | undefined,
): TrimmedHistorySelection {
  const normalizedQuery = normalizeConversationContextQuery(query);
  if (!normalizedQuery) {
    return selectRecentHistoryWindow(history, maxChars);
  }
  return selectContiguousHistoryWindow(history, maxChars, normalizedQuery);
}

function mapTrimmedHistoryEntries(entries: ConversationEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return entries.map((entry) => ({ role: entry.role, content: entry.content }));
}

function mapHistoryToChatMessages(entries: ConversationEntry[]): ChatMessage[] {
  return entries.map((entry): ChatMessage => ({ role: entry.role, content: entry.content }));
}

function findFlushedMessages(
  history: ConversationEntry[],
  cutoffIndex: number,
  flushedCount: number,
): ConversationEntry[] {
  if (cutoffIndex < 0) return [];
  const totalDroppedCount = cutoffIndex + 1;
  const boundedFlushedCount = Math.min(flushedCount, totalDroppedCount);
  return history.slice(boundedFlushedCount, totalDroppedCount);
}

function computeTotalDroppedCount(cutoffIndex: number): number {
  return cutoffIndex >= 0 ? cutoffIndex + 1 : 0;
}

function shouldFlushDroppedMessages(dropped: ConversationEntry[]): boolean {
  return dropped.length >= 2;
}

function countHistoryChars(entries: ConversationEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.content.length, 0);
}

function selectTrimmedHistory(
  history: ConversationEntry[],
  maxChars: number,
  query: string | ConversationContextQuery | undefined,
): TrimmedHistorySelection {
  return trimHistoryForContext(history, maxChars, query);
}

function resolveTrimmedHistory(
  history: ConversationEntry[],
  maxChars: number,
  query: string | ConversationContextQuery | undefined,
): TrimmedHistorySelection {
  return selectTrimmedHistory(history, maxChars, query);
}

function trimmedHistoryFits(result: TrimmedHistorySelection, maxChars: number): boolean {
  return countHistoryChars(result.entries) <= maxChars;
}

function buildTrimmedHistory(
  history: ConversationEntry[],
  maxChars: number,
  query: string | ConversationContextQuery | undefined,
): TrimmedHistorySelection {
  const result = resolveTrimmedHistory(history, maxChars, query);
  return trimmedHistoryFits(result, maxChars) ? result : selectRecentHistoryWindow(history, maxChars);
}

function toHistoryContextQuery(options?: ConversationContextOptions): string | ConversationContextQuery | undefined {
  return options?.query;
}

function normalizeHistoryContextQuery(options?: ConversationContextOptions): string | ConversationContextQuery | undefined {
  return toHistoryContextQuery(options);
}

function historyWasTrimmed(result: TrimmedHistorySelection): boolean {
  return result.cutoffIndex >= 0;
}

function filteredDroppedMessages(history: ConversationEntry[], result: TrimmedHistorySelection, flushedCount: number): ConversationEntry[] {
  return findFlushedMessages(history, result.cutoffIndex, flushedCount);
}

function droppedMessageCount(result: TrimmedHistorySelection): number {
  return computeTotalDroppedCount(result.cutoffIndex);
}

function trimmedHistoryEntries(result: TrimmedHistorySelection): ConversationEntry[] {
  return result.entries;
}

function trimConversationHistory(
  history: ConversationEntry[],
  maxChars: number,
  options?: ConversationContextOptions,
): TrimmedHistorySelection {
  return buildTrimmedHistory(history, maxChars, normalizeHistoryContextQuery(options));
}

function mapHistoryForPrompt(entries: ConversationEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return mapTrimmedHistoryEntries(entries);
}

function mapHistoryForMessages(entries: ConversationEntry[]): ChatMessage[] {
  return mapHistoryToChatMessages(entries);
}

function trimHistoryEntries(
  history: ConversationEntry[],
  maxChars: number,
  options?: ConversationContextOptions,
): TrimmedHistorySelection {
  return trimConversationHistory(history, maxChars, options);
}

function trimmedHistoryDroppedMessages(
  history: ConversationEntry[],
  result: TrimmedHistorySelection,
  flushedCount: number,
): ConversationEntry[] {
  return filteredDroppedMessages(history, result, flushedCount);
}

function trimmedHistoryTotalDroppedCount(result: TrimmedHistorySelection): number {
  return droppedMessageCount(result);
}

function shouldRecordHistoryFlush(result: TrimmedHistorySelection): boolean {
  return historyWasTrimmed(result);
}

function buildHistoryForContext(
  history: ConversationEntry[],
  maxChars: number,
  options?: ConversationContextOptions,
): TrimmedHistorySelection {
  return trimHistoryEntries(history, maxChars, options);
}

function mapPromptHistory(entries: ConversationEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return mapHistoryForPrompt(entries);
}

function mapBuildMessagesHistory(entries: ConversationEntry[]): ChatMessage[] {
  return mapHistoryForMessages(entries);
}

function normalizeConversationOptions(options?: ConversationContextOptions): ConversationContextOptions | undefined {
  return options;
}

function readConversationQuery(options?: ConversationContextOptions): string | ConversationContextQuery | undefined {
  return normalizeConversationOptions(options)?.query;
}

function trimConversationHistoryForContext(
  history: ConversationEntry[],
  maxChars: number,
  options?: ConversationContextOptions,
): TrimmedHistorySelection {
  return buildHistoryForContext(history, maxChars, { query: readConversationQuery(options) });
}

function toConversationPromptHistory(entries: ConversationEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return mapPromptHistory(entries);
}

function toConversationChatMessages(entries: ConversationEntry[]): ChatMessage[] {
  return mapBuildMessagesHistory(entries);
}

function flushableDroppedMessages(
  history: ConversationEntry[],
  result: TrimmedHistorySelection,
  flushedCount: number,
): ConversationEntry[] {
  return trimmedHistoryDroppedMessages(history, result, flushedCount);
}

function flushableDroppedCount(result: TrimmedHistorySelection): number {
  return trimmedHistoryTotalDroppedCount(result);
}

function shouldFlushHistory(result: TrimmedHistorySelection): boolean {
  return shouldRecordHistoryFlush(result);
}

function trimHistoryWithOptions(
  history: ConversationEntry[],
  maxChars: number,
  options?: ConversationContextOptions,
): TrimmedHistorySelection {
  return trimConversationHistoryForContext(history, maxChars, options);
}

function toContextHistory(entries: ConversationEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return toConversationPromptHistory(entries);
}

function toContextMessages(entries: ConversationEntry[]): ChatMessage[] {
  return toConversationChatMessages(entries);
}

function droppedHistoryForFlush(
  history: ConversationEntry[],
  result: TrimmedHistorySelection,
  flushedCount: number,
): ConversationEntry[] {
  return flushableDroppedMessages(history, result, flushedCount);
}

function totalDroppedForFlush(result: TrimmedHistorySelection): number {
  return flushableDroppedCount(result);
}

function canFlushHistory(result: TrimmedHistorySelection): boolean {
  return shouldFlushHistory(result);
}

function trimContextHistory(
  history: ConversationEntry[],
  maxChars: number,
  options?: ConversationContextOptions,
): TrimmedHistorySelection {
  return trimHistoryWithOptions(history, maxChars, options);
}

/**
 * Callback invoked when messages are dropped from context during trimming.
 * Receives the dropped messages so they can be summarized and persisted
 * to the agent's knowledge base (memory flush).
 */
export interface MemoryFlushPayload {
  sessionId: string;
  droppedMessages: ConversationEntry[];
  totalDroppedCount: number;
  newlyDroppedCount: number;
}

export type MemoryFlushCallback = (
  key: ConversationKey,
  payload: MemoryFlushPayload,
) => void;

export interface ConversationServiceOptions {
  /** Enable/disable memory entirely. */
  enabled: boolean;
  /** SQLite database path for persistence. */
  sqlitePath: string;
  /** Maximum user+assistant turns to keep per session. */
  maxTurns: number;
  /** Maximum characters per single message stored in history. */
  maxMessageChars: number;
  /** Maximum total characters from history included in context. */
  maxContextChars: number;
  /** Delete history older than this many days. */
  retentionDays: number;
  /** Clock override for testing. */
  now?: () => number;
  /** Security event callback for DB protection monitoring. */
  onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
  /**
   * Called when messages are dropped from context window during trimming.
   * Use this to flush important content to the knowledge base before it's lost.
   */
  onMemoryFlush?: MemoryFlushCallback;
}

interface MemoryStore {
  conversations: Map<string, ConversationEntry[]>;
  activeSessions: Map<string, string>;
}

/**
 * SQLite-backed conversation memory.
 *
 * If disabled, the service still works in memory but does not persist.
 */
export class ConversationService {
  private readonly options: ConversationServiceOptions;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly mode: 'sqlite' | 'memory';
  private db: SQLiteDatabase | null = null;
  private memory: MemoryStore = {
    conversations: new Map(),
    activeSessions: new Map(),
  };
  private readonly flushedMessageCounts = new Map<string, number>();
  private insertStmt: SQLiteStatement | null = null;
  private upsertActiveStmt: SQLiteStatement | null = null;
  private nextPruneAt = 0;
  private securityMonitor: SQLiteSecurityMonitor | null = null;

  constructor(options: ConversationServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionDays * 24 * 60 * 60 * 1000;

    if (!options.enabled) {
      this.mode = 'memory';
      return;
    }

    if (!hasSQLiteDriver()) {
      this.mode = 'memory';
      options.onSecurityEvent?.({
        service: 'conversation',
        severity: 'warn',
        code: 'driver_unavailable',
        message: 'node:sqlite is unavailable; falling back to in-memory conversation storage.',
        details: { sqlitePath: options.sqlitePath },
      });
      return;
    }

    try {
      mkdirSync(dirname(options.sqlitePath), { recursive: true });
      this.db = openSQLiteDatabase(options.sqlitePath, { enableForeignKeyConstraints: true });
      if (!this.db) {
        this.mode = 'memory';
        options.onSecurityEvent?.({
          service: 'conversation',
          severity: 'warn',
          code: 'driver_unavailable',
          message: 'Failed to open SQLite database; falling back to in-memory conversation storage.',
          details: { sqlitePath: options.sqlitePath },
        });
        return;
      }
      this.mode = 'sqlite';
      this.initializeSchema();
      this.securityMonitor = new SQLiteSecurityMonitor({
        service: 'conversation',
        db: this.db,
        sqlitePath: options.sqlitePath,
        onEvent: options.onSecurityEvent,
        now: this.now,
      });
      this.securityMonitor.initialize();
    } catch {
      this.mode = 'memory';
    }
  }

  /** Build LLM messages from system prompt + prior context + current user input. */
  buildMessages(
    key: ConversationKey,
    systemPrompt: string,
    userContent: string,
    options?: ConversationContextOptions,
  ): ChatMessage[] {
    const history = this.getTrimmedHistoryForContext(key, options);

    return [
      { role: 'system', content: systemPrompt },
      ...toContextMessages(history),
      { role: 'user', content: userContent },
    ];
  }

  /** Return trimmed prior user/assistant turns for worker-side prompt assembly. */
  getHistoryForContext(key: ConversationKey, options?: ConversationContextOptions): Array<{ role: 'user' | 'assistant'; content: string }> {
    return toContextHistory(this.getTrimmedHistoryForContext(key, options));
  }

  /** Return stored history for the active session without context trimming. */
  getSessionHistory(
    key: ConversationKey,
    options?: { limit?: number },
  ): Array<{ role: 'user' | 'assistant'; content: string; timestamp: number; responseSource?: ResponseSourceMetadata }> {
    const sessionId = this.getActiveSessionId(key);
    const history = this.mode === 'sqlite'
      ? this.getSessionHistorySQLite(key, sessionId)
      : this.memory.conversations.get(this.toMapKey(key, sessionId)) ?? [];
    const limit = Math.max(1, options?.limit ?? history.length);
    return history.slice(-limit).map((entry) => ({ ...entry }));
  }

  /** Record the completed user/assistant turn for future context. */
  recordTurn(
    key: ConversationKey,
    userContent: string,
    assistantContent: string,
    options?: { assistantResponseSource?: ResponseSourceMetadata },
  ): void {
    const sessionId = this.getActiveSessionId(key);
    const timestamp = this.now();
    const assistantResponseSource = this.normalizeResponseSource(options?.assistantResponseSource);

    if (this.mode === 'sqlite' && this.db && this.insertStmt) {
      this.insertStmt.run(
        key.agentId,
        key.userId,
        key.channel,
        sessionId,
        'user',
        userContent,
        timestamp,
        null,
      );
      this.insertStmt.run(
        key.agentId,
        key.userId,
        key.channel,
        sessionId,
        'assistant',
        assistantContent,
        timestamp,
        this.serializeResponseSource(assistantResponseSource),
      );
      this.securityMonitor?.maybeCheck();
      this.trimSessionSQLite(key, sessionId);
      this.pruneIfNeeded(timestamp);
      return;
    }

    const mapKey = this.toMapKey(key, sessionId);
    const existing = this.memory.conversations.get(mapKey) ?? [];
    existing.push({
      role: 'user',
      content: userContent,
      timestamp,
    });
    existing.push({
      role: 'assistant',
      content: assistantContent,
      timestamp,
      ...(assistantResponseSource ? { responseSource: assistantResponseSource } : {}),
    });
    const maxEntries = this.options.maxTurns * 2;
    if (existing.length > maxEntries) {
      existing.splice(0, existing.length - maxEntries);
    }
    this.memory.conversations.set(mapKey, existing);
  }

  /** Remove active conversation history and start a new session. */
  resetConversation(key: ConversationKey): boolean {
    const previousSessionId = this.getActiveSessionId(key);
    const newSessionId = this.rotateSession(key);
    this.flushedMessageCounts.delete(this.toMapKey(key, previousSessionId));

    if (this.mode === 'sqlite' && this.db) {
      const result = this.db
        .prepare(`
          DELETE FROM conversation_messages
          WHERE agent_id = ? AND user_id = ? AND channel = ? AND session_id = ?
        `)
        .run(key.agentId, key.userId, key.channel, previousSessionId);
      const changes = (result as { changes?: number } | undefined)?.changes ?? 0;
      return changes > 0 || previousSessionId !== newSessionId;
    }

    const mapKey = this.toMapKey(key, previousSessionId);
    const existed = this.memory.conversations.delete(mapKey);
    return existed || previousSessionId !== newSessionId;
  }

  /** Remove all conversations for one user/channel, optionally scoped to agent. */
  resetUserConversations(userId: string, channel: string, agentId?: string): number {
    this.clearFlushedMessageCountsForUser(userId, channel, agentId);
    if (this.mode === 'sqlite' && this.db) {
      let removed = 0;

      if (agentId) {
        const deleteResult = this.db
          .prepare(`
            DELETE FROM conversation_messages
            WHERE user_id = ? AND channel = ? AND agent_id = ?
          `)
          .run(userId, channel, agentId) as { changes?: number } | undefined;
        removed += Number(deleteResult?.changes ?? 0);
        this.db
          .prepare('DELETE FROM active_conversations WHERE user_id = ? AND channel = ? AND agent_id = ?')
          .run(userId, channel, agentId);
      } else {
        const deleteResult = this.db
          .prepare(`
            DELETE FROM conversation_messages
            WHERE user_id = ? AND channel = ?
          `)
          .run(userId, channel) as { changes?: number } | undefined;
        removed += Number(deleteResult?.changes ?? 0);
        this.db
          .prepare('DELETE FROM active_conversations WHERE user_id = ? AND channel = ?')
          .run(userId, channel);
      }

      return removed;
    }

    let removed = 0;
    for (const [key] of this.memory.conversations) {
      const parts = key.split('::');
      if (parts.length !== 4) continue;
      const [storedAgentId, storedUserId, storedChannel] = parts;
      if (storedUserId !== userId || storedChannel !== channel) continue;
      if (agentId && storedAgentId !== agentId) continue;
      if (this.memory.conversations.delete(key)) removed++;
    }

    for (const [key] of this.memory.activeSessions) {
      const parts = key.split('::');
      if (parts.length !== 3) continue;
      const [storedAgentId, storedUserId, storedChannel] = parts;
      if (storedUserId !== userId || storedChannel !== channel) continue;
      if (agentId && storedAgentId !== agentId) continue;
      this.memory.activeSessions.delete(key);
    }

    return removed;
  }

  /** Rotate to a new session ID for this user/channel/agent key. */
  rotateSession(key: ConversationKey): string {
    const sessionId = randomUUID();
    const timestamp = this.now();

    if (this.mode === 'sqlite' && this.upsertActiveStmt) {
      this.upsertActiveStmt.run(
        key.agentId,
        key.userId,
        key.channel,
        sessionId,
        timestamp,
      );
      return sessionId;
    }

    this.memory.activeSessions.set(this.toSessionKey(key), sessionId);
    return sessionId;
  }

  /** Return the active session ID for this key, creating one if missing. */
  getActiveSessionId(key: ConversationKey): string {
    if (this.mode === 'sqlite' && this.db && this.upsertActiveStmt) {
      const row = this.db
        .prepare(`
          SELECT session_id
          FROM active_conversations
          WHERE agent_id = ? AND user_id = ? AND channel = ?
        `)
        .get(key.agentId, key.userId, key.channel) as SessionRow | undefined;

      if (row?.session_id) return row.session_id;

      const sessionId = randomUUID();
      this.upsertActiveStmt.run(
        key.agentId,
        key.userId,
        key.channel,
        sessionId,
        this.now(),
      );
      return sessionId;
    }

    const sessionKey = this.toSessionKey(key);
    const existing = this.memory.activeSessions.get(sessionKey);
    if (existing) return existing;
    const created = randomUUID();
    this.memory.activeSessions.set(sessionKey, created);
    return created;
  }

  /** Set active session ID when users restore past threads. */
  setActiveSession(key: ConversationKey, sessionId: string): boolean {
    const trimmed = sessionId.trim();
    if (!trimmed) return false;

    if (this.mode === 'sqlite' && this.db && this.upsertActiveStmt) {
      const existsRow = this.db
        .prepare(`
          SELECT COUNT(*) as count
          FROM conversation_messages
          WHERE agent_id = ? AND user_id = ? AND channel = ? AND session_id = ?
        `)
        .get(key.agentId, key.userId, key.channel, trimmed) as CountRow | undefined;

      if (!existsRow || existsRow.count < 1) return false;

      this.upsertActiveStmt.run(
        key.agentId,
        key.userId,
        key.channel,
        trimmed,
        this.now(),
      );
      return true;
    }

    const exists = this.memory.conversations.has(this.toMapKey(key, trimmed));
    if (!exists) return false;
    this.memory.activeSessions.set(this.toSessionKey(key), trimmed);
    return true;
  }

  /** List persisted sessions for one user/channel, optionally by agent. */
  listSessions(userId: string, channel: string, agentId?: string): ConversationSessionInfo[] {
    if (this.mode === 'sqlite' && this.db) {
      if (agentId) {
        const active = this.getActiveSessionId({ agentId, userId, channel });
        const rows = this.db
          .prepare(`
            SELECT session_id, COUNT(*) as message_count, MAX(timestamp) as last_message_at
            FROM conversation_messages
            WHERE user_id = ? AND channel = ? AND agent_id = ?
            GROUP BY session_id
            ORDER BY last_message_at DESC
            LIMIT 100
          `)
          .all(userId, channel, agentId) as unknown as SessionSummaryRow[];
        return rows.map((row) => ({
          sessionId: row.session_id,
          messageCount: row.message_count,
          lastMessageAt: row.last_message_at,
          isActive: row.session_id === active,
        }));
      }

      const rows = this.db
        .prepare(`
          SELECT session_id, COUNT(*) as message_count, MAX(timestamp) as last_message_at
          FROM conversation_messages
          WHERE user_id = ? AND channel = ?
          GROUP BY session_id
          ORDER BY last_message_at DESC
          LIMIT 100
        `)
        .all(userId, channel) as unknown as SessionSummaryRow[];

      return rows.map((row) => ({
        sessionId: row.session_id,
        messageCount: row.message_count,
        lastMessageAt: row.last_message_at,
        isActive: false,
      }));
    }

    const sessions = new Map<string, ConversationSessionInfo>();

    for (const [key, entries] of this.memory.conversations) {
      const parts = key.split('::');
      if (parts.length !== 4) continue;
      const [storedAgentId, storedUserId, storedChannel, storedSessionId] = parts;
      if (storedUserId !== userId || storedChannel !== channel) continue;
      if (agentId && storedAgentId !== agentId) continue;
      if (entries.length === 0) continue;

      const lastMessageAt = entries[entries.length - 1].timestamp;
      sessions.set(storedSessionId, {
        sessionId: storedSessionId,
        messageCount: entries.length,
        lastMessageAt,
        isActive: false,
      });
    }

    if (agentId) {
      const active = this.getActiveSessionId({ agentId, userId, channel });
      const activeRow = sessions.get(active);
      if (activeRow) {
        activeRow.isActive = true;
      }
    }

    return [...sessions.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.insertStmt = null;
    this.upsertActiveStmt = null;
    this.securityMonitor = null;
    this.flushedMessageCounts.clear();
  }

  private getTrimmedHistoryForContext(key: ConversationKey, options?: ConversationContextOptions): ConversationEntry[] {
    const sessionId = this.getActiveSessionId(key);
    const history = this.mode === 'sqlite'
      ? this.getSessionHistorySQLite(key, sessionId)
      : this.memory.conversations.get(this.toMapKey(key, sessionId)) ?? [];

    if (history.length === 0) return [];

    const contextHistory = history.map((entry) => ({
      ...entry,
      content: this.truncateContentForContext(entry.content),
    }));
    const trimmed = trimContextHistory(contextHistory, this.options.maxContextChars, options);

    if (canFlushHistory(trimmed) && this.options.onMemoryFlush) {
      const totalDroppedCount = totalDroppedForFlush(trimmed);
      const contextKey = this.toMapKey(key, sessionId);
      const flushedCount = Math.min(this.flushedMessageCounts.get(contextKey) ?? 0, totalDroppedCount);
      const dropped = droppedHistoryForFlush(contextHistory, trimmed, flushedCount);
      if (shouldFlushDroppedMessages(dropped)) {
        try {
          this.options.onMemoryFlush(key, {
            sessionId,
            droppedMessages: dropped.map((entry) => ({ ...entry })),
            totalDroppedCount,
            newlyDroppedCount: dropped.length,
          });
          this.flushedMessageCounts.set(contextKey, totalDroppedCount);
        } catch {
          // Flush failure should never break message building
        }
      }
    }

    return trimmedHistoryEntries(trimmed);
  }

  private getSessionHistorySQLite(key: ConversationKey, sessionId: string): ConversationEntry[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(`
        SELECT role, content, timestamp, response_source_json
        FROM conversation_messages
        WHERE agent_id = ? AND user_id = ? AND channel = ? AND session_id = ?
        ORDER BY id ASC
      `)
      .all(key.agentId, key.userId, key.channel, sessionId) as unknown as MessageRow[];

    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      ...(this.parseResponseSource(row.response_source_json)
        ? { responseSource: this.parseResponseSource(row.response_source_json) }
        : {}),
    }));
  }

  private trimSessionSQLite(key: ConversationKey, sessionId: string): void {
    if (!this.db) return;

    const countRow = this.db
      .prepare(`
        SELECT COUNT(*) as count
        FROM conversation_messages
        WHERE agent_id = ? AND user_id = ? AND channel = ? AND session_id = ?
      `)
      .get(key.agentId, key.userId, key.channel, sessionId) as CountRow | undefined;

    const maxEntries = this.options.maxTurns * 2;
    const count = countRow?.count ?? 0;
    if (count <= maxEntries) return;

    const toDelete = count - maxEntries;
    this.db
      .prepare(`
        DELETE FROM conversation_messages
        WHERE id IN (
          SELECT id
          FROM conversation_messages
          WHERE agent_id = ? AND user_id = ? AND channel = ? AND session_id = ?
          ORDER BY id ASC
          LIMIT ?
        )
      `)
      .run(key.agentId, key.userId, key.channel, sessionId, toDelete);
  }

  private initializeSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        response_source_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_lookup
        ON conversation_messages(agent_id, user_id, channel, session_id, id);

      CREATE INDEX IF NOT EXISTS idx_conversation_timestamp
        ON conversation_messages(timestamp);

      CREATE TABLE IF NOT EXISTS active_conversations (
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, user_id, channel)
      );
    `);

    try {
      this.db.exec('ALTER TABLE conversation_messages ADD COLUMN response_source_json TEXT');
    } catch {
      // Column already exists or migration is not needed.
    }

    // FTS5 virtual table for full-text search across conversation content.
    // Uses content-sync (content=) to avoid data duplication — the FTS index
    // references conversation_messages rows by rowid.
    this.initializeFTS();

    this.insertStmt = this.db.prepare(`
      INSERT INTO conversation_messages (
        agent_id, user_id, channel, session_id, role, content, timestamp, response_source_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.upsertActiveStmt = this.db.prepare(`
      INSERT INTO active_conversations (
        agent_id, user_id, channel, session_id, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, user_id, channel)
      DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `);
  }

  private ftsAvailable = false;

  private initializeFTS(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts
        USING fts5(
          content,
          content='conversation_messages',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        -- Keep FTS index in sync on INSERT
        CREATE TRIGGER IF NOT EXISTS conversation_fts_insert
        AFTER INSERT ON conversation_messages BEGIN
          INSERT INTO conversation_messages_fts(rowid, content) VALUES (new.id, new.content);
        END;

        -- Keep FTS index in sync on DELETE
        CREATE TRIGGER IF NOT EXISTS conversation_fts_delete
        AFTER DELETE ON conversation_messages BEGIN
          INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
        END;
      `);
      this.ftsAvailable = true;

      // Rebuild FTS if it's empty but messages exist (handles upgrade from pre-FTS schema)
      const ftsCount = this.db
        .prepare('SELECT COUNT(*) as count FROM conversation_messages_fts')
        .get() as CountRow | undefined;
      const msgCount = this.db
        .prepare('SELECT COUNT(*) as count FROM conversation_messages')
        .get() as CountRow | undefined;
      if ((ftsCount?.count ?? 0) === 0 && (msgCount?.count ?? 0) > 0) {
        this.db.exec(`INSERT INTO conversation_messages_fts(conversation_messages_fts) VALUES ('rebuild')`);
      }
    } catch {
      // FTS5 may not be compiled into this SQLite build — degrade gracefully
      this.ftsAvailable = false;
    }
  }

  /**
   * Full-text search across conversation history using FTS5 BM25 ranking.
   *
   * @param query  - FTS5 match expression (words, phrases, boolean operators)
   * @param opts   - Optional filters: userId, agentId, channel, limit
   * @returns Scored results sorted by relevance (best first)
   */
  searchMessages(
    query: string,
    opts?: {
      userId?: string;
      agentId?: string;
      channel?: string;
      limit?: number;
    },
  ): ConversationSearchResult[] {
    const limit = Math.min(opts?.limit ?? 20, 100);

    if (this.mode === 'sqlite' && this.db && this.ftsAvailable) {
      return this.searchMessagesFTS(query, opts, limit);
    }

    // Fallback: naive substring search over in-memory store
    return this.searchMessagesMemory(query, opts, limit);
  }

  /** Whether FTS5 full-text search is available. */
  get hasFTS(): boolean {
    return this.ftsAvailable;
  }

  private searchMessagesFTS(
    query: string,
    opts: { userId?: string; agentId?: string; channel?: string } | undefined,
    limit: number,
  ): ConversationSearchResult[] {
    if (!this.db) return [];

    // Sanitize FTS query: escape special characters to prevent injection
    const safeQuery = query.replace(/['"]/g, ' ').trim();
    if (!safeQuery) return [];

    // Build WHERE clause with optional filters
    const filters: string[] = [];
    const params: unknown[] = [safeQuery];

    if (opts?.userId) {
      filters.push('m.user_id = ?');
      params.push(opts.userId);
    }
    if (opts?.agentId) {
      filters.push('m.agent_id = ?');
      params.push(opts.agentId);
    }
    if (opts?.channel) {
      filters.push('m.channel = ?');
      params.push(opts.channel);
    }

    const whereClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
    params.push(limit);

    const sql = `
      SELECT
        bm25(conversation_messages_fts) as score,
        m.role, m.content, m.timestamp,
        m.agent_id, m.user_id, m.channel, m.session_id
      FROM conversation_messages_fts fts
      JOIN conversation_messages m ON m.id = fts.rowid
      WHERE fts.content MATCH ?
        ${whereClause}
      ORDER BY bm25(conversation_messages_fts)
      LIMIT ?
    `;

    try {
      const rows = this.db.prepare(sql).all(...params) as unknown as FTSSearchRow[];
      return rows.map((row) => ({
        score: row.score,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        agentId: row.agent_id,
        userId: row.user_id,
        channel: row.channel,
        sessionId: row.session_id,
      }));
    } catch {
      // Query syntax error or FTS issue — return empty
      return [];
    }
  }

  private searchMessagesMemory(
    query: string,
    opts: { userId?: string; agentId?: string; channel?: string } | undefined,
    limit: number,
  ): ConversationSearchResult[] {
    const lowerQuery = query.toLowerCase();
    const results: ConversationSearchResult[] = [];

    for (const [mapKey, entries] of this.memory.conversations) {
      const parts = mapKey.split('::');
      if (parts.length !== 4) continue;
      const [agentId, userId, channel, sessionId] = parts;

      if (opts?.userId && userId !== opts.userId) continue;
      if (opts?.agentId && agentId !== opts.agentId) continue;
      if (opts?.channel && channel !== opts.channel) continue;

      for (const entry of entries) {
        if (entry.content.toLowerCase().includes(lowerQuery)) {
          results.push({
            score: 0,
            role: entry.role,
            content: entry.content,
            timestamp: entry.timestamp,
            agentId,
            userId,
            channel,
            sessionId,
          });
          if (results.length >= limit) return results;
        }
      }
    }

    return results;
  }

  private pruneIfNeeded(now: number): void {
    if (!this.db) return;
    if (now < this.nextPruneAt) return;

    this.nextPruneAt = now + 60 * 60 * 1000;
    const cutoff = now - this.retentionMs;

    this.db
      .prepare('DELETE FROM conversation_messages WHERE timestamp < ?')
      .run(cutoff);

    this.db.exec(`
      DELETE FROM active_conversations
      WHERE NOT EXISTS (
        SELECT 1
        FROM conversation_messages
        WHERE conversation_messages.agent_id = active_conversations.agent_id
          AND conversation_messages.user_id = active_conversations.user_id
          AND conversation_messages.channel = active_conversations.channel
          AND conversation_messages.session_id = active_conversations.session_id
      );
    `);
  }

  private truncateContentForContext(content: string): string {
    if (content.length <= this.options.maxMessageChars) return content;
    return content.slice(0, this.options.maxMessageChars) + ' [truncated]';
  }

  private normalizeResponseSource(value: ResponseSourceMetadata | undefined): ResponseSourceMetadata | undefined {
    if (!value) return undefined;
    if (value.locality !== 'local' && value.locality !== 'external') return undefined;
    return {
      locality: value.locality,
      ...(typeof value.providerName === 'string' && value.providerName.trim()
        ? { providerName: value.providerName.trim() }
        : {}),
      ...(typeof value.providerProfileName === 'string' && value.providerProfileName.trim()
        ? { providerProfileName: value.providerProfileName.trim() }
        : {}),
      ...(typeof value.model === 'string' && value.model.trim()
        ? { model: value.model.trim() }
        : {}),
      ...(value.tier === 'local' || value.tier === 'external'
        ? { tier: value.tier }
        : {}),
      ...(value.usedFallback === true ? { usedFallback: true } : {}),
      ...(typeof value.notice === 'string' && value.notice.trim()
        ? { notice: value.notice.trim() }
        : {}),
      ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
        ? { durationMs: value.durationMs }
        : {}),
      ...(value.usage
        && typeof value.usage.promptTokens === 'number'
        && Number.isFinite(value.usage.promptTokens)
        && typeof value.usage.completionTokens === 'number'
        && Number.isFinite(value.usage.completionTokens)
        && typeof value.usage.totalTokens === 'number'
        && Number.isFinite(value.usage.totalTokens)
        ? {
            usage: {
              promptTokens: value.usage.promptTokens,
              completionTokens: value.usage.completionTokens,
              totalTokens: value.usage.totalTokens,
              ...(typeof value.usage.cacheCreationTokens === 'number' && Number.isFinite(value.usage.cacheCreationTokens)
                ? { cacheCreationTokens: value.usage.cacheCreationTokens }
                : {}),
              ...(typeof value.usage.cacheReadTokens === 'number' && Number.isFinite(value.usage.cacheReadTokens)
                ? { cacheReadTokens: value.usage.cacheReadTokens }
                : {}),
            },
          }
        : {}),
    };
  }

  private serializeResponseSource(value: ResponseSourceMetadata | undefined): string | null {
    const normalized = this.normalizeResponseSource(value);
    if (!normalized) return null;
    return JSON.stringify(normalized);
  }

  private parseResponseSource(value: string | null | undefined): ResponseSourceMetadata | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as ResponseSourceMetadata;
      return this.normalizeResponseSource(parsed);
    } catch {
      return undefined;
    }
  }

  private clearFlushedMessageCountsForUser(userId: string, channel: string, agentId?: string): void {
    for (const key of this.flushedMessageCounts.keys()) {
      const parts = key.split('::');
      if (parts.length !== 4) continue;
      const [storedAgentId, storedUserId, storedChannel] = parts;
      if (storedUserId !== userId || storedChannel !== channel) continue;
      if (agentId && storedAgentId !== agentId) continue;
      this.flushedMessageCounts.delete(key);
    }
  }

  private toMapKey(key: ConversationKey, sessionId: string): string {
    return `${key.agentId}::${key.userId}::${key.channel}::${sessionId}`;
  }

  private toSessionKey(key: ConversationKey): string {
    return `${key.agentId}::${key.userId}::${key.channel}`;
  }
}
