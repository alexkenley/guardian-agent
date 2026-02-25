/**
 * Conversation memory service with SQLite persistence and session controls.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage } from '../llm/types.js';
import { SQLiteSecurityMonitor, type SQLiteSecurityEvent } from './sqlite-security.js';
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

interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
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
  ): ChatMessage[] {
    const history = this.getTrimmedHistoryForContext(key);

    return [
      { role: 'system', content: systemPrompt },
      ...history.map((entry): ChatMessage => ({
        role: entry.role,
        content: entry.content,
      })),
      { role: 'user', content: userContent },
    ];
  }

  /** Record the completed user/assistant turn for future context. */
  recordTurn(key: ConversationKey, userContent: string, assistantContent: string): void {
    const sessionId = this.getActiveSessionId(key);
    const timestamp = this.now();

    if (this.mode === 'sqlite' && this.db && this.insertStmt) {
      this.insertStmt.run(
        key.agentId,
        key.userId,
        key.channel,
        sessionId,
        'user',
        this.sanitizeContent(userContent),
        timestamp,
      );
      this.insertStmt.run(
        key.agentId,
        key.userId,
        key.channel,
        sessionId,
        'assistant',
        this.sanitizeContent(assistantContent),
        timestamp,
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
      content: this.sanitizeContent(userContent),
      timestamp,
    });
    existing.push({
      role: 'assistant',
      content: this.sanitizeContent(assistantContent),
      timestamp,
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
  }

  private getTrimmedHistoryForContext(key: ConversationKey): ConversationEntry[] {
    const sessionId = this.getActiveSessionId(key);
    const history = this.mode === 'sqlite'
      ? this.getSessionHistorySQLite(key, sessionId)
      : this.memory.conversations.get(this.toMapKey(key, sessionId)) ?? [];

    if (history.length === 0) return [];

    const reversed: ConversationEntry[] = [];
    let totalChars = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      const nextTotal = totalChars + entry.content.length;
      if (nextTotal > this.options.maxContextChars) break;
      reversed.push(entry);
      totalChars = nextTotal;
    }

    return reversed.reverse();
  }

  private getSessionHistorySQLite(key: ConversationKey, sessionId: string): ConversationEntry[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(`
        SELECT role, content, timestamp
        FROM conversation_messages
        WHERE agent_id = ? AND user_id = ? AND channel = ? AND session_id = ?
        ORDER BY id ASC
      `)
      .all(key.agentId, key.userId, key.channel, sessionId) as unknown as MessageRow[];

    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
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
        timestamp INTEGER NOT NULL
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

    this.insertStmt = this.db.prepare(`
      INSERT INTO conversation_messages (
        agent_id, user_id, channel, session_id, role, content, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.upsertActiveStmt = this.db.prepare(`
      INSERT INTO active_conversations (
        agent_id, user_id, channel, session_id, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, user_id, channel)
      DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `);
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

  private sanitizeContent(content: string): string {
    if (content.length <= this.options.maxMessageChars) return content;
    return content.slice(0, this.options.maxMessageChars) + ' [truncated]';
  }

  private toMapKey(key: ConversationKey, sessionId: string): string {
    return `${key.agentId}::${key.userId}::${key.channel}::${sessionId}`;
  }

  private toSessionKey(key: ConversationKey): string {
    return `${key.agentId}::${key.userId}::${key.channel}`;
  }
}
