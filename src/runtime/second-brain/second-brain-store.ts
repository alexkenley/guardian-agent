import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  hasSQLiteDriver,
  openSQLiteDatabase,
  type SQLiteDatabase,
} from '../sqlite-driver.js';
import type { SQLiteSecurityEvent } from '../sqlite-security.js';
import type {
  SecondBrainBriefRecord,
  SecondBrainEventRecord,
  SecondBrainLinkRecord,
  SecondBrainNoteRecord,
  SecondBrainPersonRecord,
  SecondBrainRoutineRecord,
  SecondBrainSyncCursorRecord,
  SecondBrainTaskRecord,
  SecondBrainUsageRecord,
} from './types.js';

import { BriefStore } from './brief-store.js';
import { NoteStore } from './note-store.js';
import { TaskStore } from './task-store.js';
import { RoutineStore } from './routine-store.js';
import { PeopleStore } from './people-store.js';
import { CalendarStore } from './calendar-store.js';
import { UsageStore } from './usage-store.js';
import { SyncCursorStore } from './sync-cursor-store.js';
import { LinkStore } from './link-store.js';

export interface SecondBrainStoreOptions {
  sqlitePath: string;
  now?: () => number;
  onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
}

export interface MemoryStore {
  notes: Map<string, SecondBrainNoteRecord>;
  tasks: Map<string, SecondBrainTaskRecord>;
  people: Map<string, SecondBrainPersonRecord>;
  links: Map<string, SecondBrainLinkRecord>;
  routines: Map<string, SecondBrainRoutineRecord>;
  briefs: Map<string, SecondBrainBriefRecord>;
  syncCursors: Map<string, SecondBrainSyncCursorRecord>;
  usage: SecondBrainUsageRecord[];
  events: Map<string, SecondBrainEventRecord>;
}

export interface SecondBrainStoreContext {
  readonly now: () => number;
  readonly mode: 'sqlite' | 'memory';
  readonly memory: MemoryStore;
  readonly db: SQLiteDatabase | null;
}

export class SecondBrainStore implements SecondBrainStoreContext {
  public readonly now: () => number;
  public readonly mode: 'sqlite' | 'memory';
  public readonly memory: MemoryStore = {
    notes: new Map(),
    tasks: new Map(),
    people: new Map(),
    links: new Map(),
    routines: new Map(),
    briefs: new Map(),
    syncCursors: new Map(),
    usage: [],
    events: new Map(),
  };
  public readonly db: SQLiteDatabase | null;

  public readonly notes: NoteStore;
  public readonly tasks: TaskStore;
  public readonly routines: RoutineStore;
  public readonly people: PeopleStore;
  public readonly calendar: CalendarStore;
  public readonly links: LinkStore;
  public readonly briefs: BriefStore;
  public readonly syncCursors: SyncCursorStore;
  public readonly usage: UsageStore;

  constructor(options: SecondBrainStoreOptions) {
    this.now = options.now ?? Date.now;

    if (!hasSQLiteDriver()) {
      this.mode = 'memory';
      this.db = null;
      options.onSecurityEvent?.({
        service: 'second_brain',
        severity: 'warn',
        code: 'driver_unavailable',
        message: 'node:sqlite is unavailable; using in-memory Second Brain storage.',
        details: { sqlitePath: options.sqlitePath },
      });
    } else {
      mkdirSync(dirname(options.sqlitePath), { recursive: true });
      this.db = openSQLiteDatabase(options.sqlitePath, { enableForeignKeyConstraints: true });
      if (!this.db) {
        this.mode = 'memory';
        options.onSecurityEvent?.({
          service: 'second_brain',
          severity: 'warn',
          code: 'driver_open_failed',
          message: 'Failed to open Second Brain SQLite database; using in-memory storage.',
          details: { sqlitePath: options.sqlitePath },
        });
      } else {
        this.mode = 'sqlite';
        this.initializeSchema();
      }
    }

    this.notes = new NoteStore(this);
    this.tasks = new TaskStore(this);
    this.routines = new RoutineStore(this);
    this.people = new PeopleStore(this);
    this.calendar = new CalendarStore(this);
    this.links = new LinkStore(this);
    this.briefs = new BriefStore(this);
    this.syncCursors = new SyncCursorStore(this);
    this.usage = new UsageStore(this);
  }

  private initializeSchema(): void {
    this.db?.exec(`
      CREATE TABLE IF NOT EXISTS sb_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        due_at INTEGER,
        source TEXT NOT NULL,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_people (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER,
        source TEXT NOT NULL,
        location TEXT,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_reminders (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        enabled_by_default INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_json TEXT NOT NULL,
        workload_class TEXT NOT NULL,
        external_comm_mode TEXT NOT NULL,
        budget_profile_id TEXT NOT NULL,
        delivery_defaults_json TEXT NOT NULL,
        default_routing_bias TEXT NOT NULL,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_briefs (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_links (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sb_usage_records (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        route TEXT NOT NULL,
        feature_area TEXT NOT NULL,
        feature_id TEXT,
        provider TEXT,
        locality TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        connector_calls INTEGER,
        outbound_action TEXT
      );

      CREATE TABLE IF NOT EXISTS sb_sync_cursors (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  getCounts(): { notes: number; tasks: number; routines: number } {
    if (this.mode === 'memory') {
      return {
        notes: this.memory.notes.size,
        tasks: this.memory.tasks.size,
        routines: this.memory.routines.size,
      };
    }

    const count = (table: string) => {
      const row = this.db!.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number } | undefined;
      return row?.count ?? 0;
    };
    return {
      notes: count('sb_notes'),
      tasks: count('sb_tasks'),
      routines: count('sb_routines'),
    };
  }

  close(): void {
    this.db?.close();
  }
}
