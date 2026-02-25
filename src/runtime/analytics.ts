/**
 * Channel analytics with SQLite persistence.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SQLiteSecurityMonitor, type SQLiteSecurityEvent } from './sqlite-security.js';
import {
  hasSQLiteDriver,
  openSQLiteDatabase,
  type SQLiteDatabase,
  type SQLiteStatement,
} from './sqlite-driver.js';

export interface AnalyticsEventInput {
  type: string;
  channel?: string;
  canonicalUserId?: string;
  channelUserId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsEvent extends AnalyticsEventInput {
  id: number;
  timestamp: number;
}

export interface AnalyticsSummary {
  windowMs: number;
  totalEvents: number;
  byType: Record<string, number>;
  byChannel: Record<string, number>;
  topAgents: Array<{ agentId: string; count: number }>;
  commandUsage: Array<{ command: string; count: number }>;
  lastEventAt?: number;
}

export interface AnalyticsServiceOptions {
  enabled: boolean;
  sqlitePath: string;
  retentionDays: number;
  now?: () => number;
  onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
}

interface CountRow {
  count: number;
}

interface GroupedCountRow {
  key: string;
  count: number;
}

interface EventRow {
  id: number;
  timestamp: number;
  type: string;
  channel: string | null;
  canonical_user_id: string | null;
  channel_user_id: string | null;
  agent_id: string | null;
  metadata_json: string | null;
}

/**
 * Persistent analytics tracker for UX and reliability telemetry.
 */
export class AnalyticsService {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly mode: 'sqlite' | 'memory' | 'disabled';
  private db: SQLiteDatabase | null = null;
  private insertStmt: SQLiteStatement | null = null;
  private nextPruneAt = 0;
  private securityMonitor: SQLiteSecurityMonitor | null = null;
  private memoryEvents: AnalyticsEvent[] = [];
  private nextMemoryId = 1;

  constructor(options: AnalyticsServiceOptions) {
    this.enabled = options.enabled;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionDays * 24 * 60 * 60 * 1000;

    if (!this.enabled) {
      this.mode = 'disabled';
      return;
    }

    if (!hasSQLiteDriver()) {
      this.mode = 'memory';
      options.onSecurityEvent?.({
        service: 'analytics',
        severity: 'warn',
        code: 'driver_unavailable',
        message: 'node:sqlite is unavailable; using in-memory analytics storage.',
        details: { sqlitePath: options.sqlitePath },
      });
      return;
    }

    mkdirSync(dirname(options.sqlitePath), { recursive: true });
    this.db = openSQLiteDatabase(options.sqlitePath, { enableForeignKeyConstraints: true });
    if (!this.db) {
      this.mode = 'memory';
      options.onSecurityEvent?.({
        service: 'analytics',
        severity: 'warn',
        code: 'driver_unavailable',
        message: 'Failed to open SQLite database; using in-memory analytics storage.',
        details: { sqlitePath: options.sqlitePath },
      });
      return;
    }
    this.mode = 'sqlite';
    this.initializeSchema();
    this.securityMonitor = new SQLiteSecurityMonitor({
      service: 'analytics',
      db: this.db,
      sqlitePath: options.sqlitePath,
      onEvent: options.onSecurityEvent,
      now: this.now,
    });
    this.securityMonitor.initialize();
  }

  track(event: AnalyticsEventInput): void {
    if (!this.enabled) return;

    const timestamp = this.now();
    if (this.mode === 'sqlite' && this.db && this.insertStmt) {
      this.insertStmt.run(
        timestamp,
        event.type,
        event.channel ?? null,
        event.canonicalUserId ?? null,
        event.channelUserId ?? null,
        event.agentId ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      );
      this.securityMonitor?.maybeCheck();
      this.pruneIfNeeded(timestamp);
      return;
    }

    this.memoryEvents.unshift({
      id: this.nextMemoryId++,
      timestamp,
      ...event,
    });
    this.pruneIfNeeded(timestamp);
  }

  summary(windowMs: number): AnalyticsSummary {
    if (!this.enabled || this.mode === 'disabled') {
      return {
        windowMs,
        totalEvents: 0,
        byType: {},
        byChannel: {},
        topAgents: [],
        commandUsage: [],
      };
    }

    if (this.mode === 'memory') {
      return this.summaryFromMemory(windowMs);
    }

    if (!this.db) {
      return this.summaryFromMemory(windowMs);
    }
    const db = this.db;
    const after = this.now() - windowMs;
    const totalRow = db
      .prepare('SELECT COUNT(*) as count FROM assistant_analytics WHERE timestamp >= ?')
      .get(after) as CountRow | undefined;

    const byTypeRows = db
      .prepare(`
        SELECT type as key, COUNT(*) as count
        FROM assistant_analytics
        WHERE timestamp >= ?
        GROUP BY type
        ORDER BY count DESC
      `)
      .all(after) as unknown as GroupedCountRow[];

    const byChannelRows = db
      .prepare(`
        SELECT channel as key, COUNT(*) as count
        FROM assistant_analytics
        WHERE timestamp >= ? AND channel IS NOT NULL
        GROUP BY channel
        ORDER BY count DESC
      `)
      .all(after) as unknown as GroupedCountRow[];

    const topAgents = db
      .prepare(`
        SELECT agent_id as key, COUNT(*) as count
        FROM assistant_analytics
        WHERE timestamp >= ? AND agent_id IS NOT NULL
        GROUP BY agent_id
        ORDER BY count DESC
        LIMIT 5
      `)
      .all(after) as unknown as GroupedCountRow[];

    const lastRow = db
      .prepare('SELECT timestamp FROM assistant_analytics ORDER BY timestamp DESC LIMIT 1')
      .get() as { timestamp: number } | undefined;

    const commandRows = db
      .prepare(`
        SELECT metadata_json
        FROM assistant_analytics
        WHERE timestamp >= ? AND type = 'command_used' AND metadata_json IS NOT NULL
      `)
      .all(after) as Array<{ metadata_json: string }>;

    const byType = toCountMap(byTypeRows);
    const byChannel = toCountMap(byChannelRows);
    const commandUsage = parseCommandUsage(commandRows);

    return {
      windowMs,
      totalEvents: totalRow?.count ?? 0,
      byType,
      byChannel,
      topAgents: topAgents.map((row) => ({ agentId: row.key, count: row.count })),
      commandUsage,
      lastEventAt: lastRow?.timestamp,
    };
  }

  recent(limit = 50): AnalyticsEvent[] {
    if (!this.enabled || this.mode === 'disabled') return [];
    if (this.mode === 'memory') {
      return this.memoryEvents.slice(0, Math.max(1, limit));
    }
    if (!this.db) {
      return this.memoryEvents.slice(0, Math.max(1, limit));
    }
    const rows = this.db
      .prepare(`
        SELECT id, timestamp, type, channel, canonical_user_id, channel_user_id, agent_id, metadata_json
        FROM assistant_analytics
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .all(limit) as unknown as EventRow[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      type: row.type,
      channel: row.channel ?? undefined,
      canonicalUserId: row.canonical_user_id ?? undefined,
      channelUserId: row.channel_user_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      metadata: row.metadata_json ? safeParseJSON(row.metadata_json) : undefined,
    }));
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.insertStmt = null;
    this.securityMonitor = null;
    this.memoryEvents = [];
  }

  private initializeSchema(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        channel TEXT,
        canonical_user_id TEXT,
        channel_user_id TEXT,
        agent_id TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_assistant_analytics_timestamp
        ON assistant_analytics(timestamp);

      CREATE INDEX IF NOT EXISTS idx_assistant_analytics_type_timestamp
        ON assistant_analytics(type, timestamp);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO assistant_analytics (
        timestamp, type, channel, canonical_user_id, channel_user_id, agent_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private pruneIfNeeded(now: number): void {
    if (now < this.nextPruneAt) return;

    this.nextPruneAt = now + 60 * 60 * 1000; // hourly
    const cutoff = now - this.retentionMs;
    if (this.mode === 'sqlite' && this.db) {
      this.db
        .prepare('DELETE FROM assistant_analytics WHERE timestamp < ?')
        .run(cutoff);
      return;
    }

    if (this.mode === 'memory') {
      this.memoryEvents = this.memoryEvents.filter((event) => event.timestamp >= cutoff);
    }
  }

  private summaryFromMemory(windowMs: number): AnalyticsSummary {
    const after = this.now() - windowMs;
    const scoped = this.memoryEvents.filter((event) => event.timestamp >= after);

    const byType = countBy(scoped.map((event) => event.type));
    const byChannel = countBy(scoped.map((event) => event.channel).filter((channel): channel is string => !!channel));
    const topAgentsMap = countBy(scoped.map((event) => event.agentId).filter((agentId): agentId is string => !!agentId));
    const topAgents = Object.entries(topAgentsMap)
      .map(([agentId, count]) => ({ agentId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const commandUsageMap = countBy(
      scoped
        .filter((event) => event.type === 'command_used')
        .map((event) => event.metadata?.['command'])
        .filter((value): value is string => typeof value === 'string'),
    );
    const commandUsage = Object.entries(commandUsageMap)
      .map(([command, count]) => ({ command, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      windowMs,
      totalEvents: scoped.length,
      byType,
      byChannel,
      topAgents,
      commandUsage,
      lastEventAt: this.memoryEvents[0]?.timestamp,
    };
  }
}

function toCountMap(rows: GroupedCountRow[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.key] = row.count;
  }
  return map;
}

function parseCommandUsage(rows: Array<{ metadata_json: string }>): Array<{ command: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const parsed = safeParseJSON(row.metadata_json);
    const command = parsed && typeof parsed['command'] === 'string'
      ? parsed['command']
      : undefined;
    if (!command) continue;
    counts.set(command, (counts.get(command) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function safeParseJSON(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function countBy(values: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const value of values) {
    map[value] = (map[value] ?? 0) + 1;
  }
  return map;
}
