import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeUserFacingIntentGatewaySummary } from './intent/summary.js';
import { SQLiteSecurityMonitor, type SQLiteSecurityEvent } from './sqlite-security.js';
import {
  hasSQLiteDriver,
  openSQLiteDatabase,
  type SQLiteDatabase,
  type SQLiteStatement,
} from './sqlite-driver.js';

export interface ContinuityThreadScope {
  assistantId: string;
  userId: string;
}

export interface ContinuityThreadSurfaceLink {
  channel: string;
  surfaceId: string;
  active: boolean;
  lastSeenAt: number;
}

export interface ContinuityThreadExecutionRef {
  kind: 'code_session' | 'pending_action' | 'automation' | 'auth_flow' | 'execution';
  id: string;
  label?: string;
}

export interface ContinuityThreadContinuationState {
  kind: string;
  payload: Record<string, unknown>;
}

export interface ContinuityThreadRecord {
  continuityKey: string;
  scope: ContinuityThreadScope;
  linkedSurfaces: ContinuityThreadSurfaceLink[];
  focusSummary?: string;
  lastActionableRequest?: string;
  activeExecutionRefs?: ContinuityThreadExecutionRef[];
  continuationState?: ContinuityThreadContinuationState;
  safeSummary?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface ContinuityThreadStoreOptions {
  enabled?: boolean;
  sqlitePath: string;
  retentionDays: number;
  now?: () => number;
  onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
}

export interface ContinuityThreadUpsertInput {
  touchSurface?: {
    channel: string;
    surfaceId: string;
  };
  focusSummary?: string | null;
  lastActionableRequest?: string | null;
  activeExecutionRefs?: ContinuityThreadExecutionRef[] | null;
  continuationState?: ContinuityThreadContinuationState | null;
  safeSummary?: string | null;
}

interface StoredContinuityThreadRow {
  continuity_key: string;
  assistant_id: string;
  user_id: string;
  updated_at: number;
  expires_at: number;
  payload_json: string;
}

function buildContinuityKey(scope: ContinuityThreadScope): string {
  return `${scope.assistantId}:${scope.userId}`;
}

function cloneExecutionRef(ref: ContinuityThreadExecutionRef): ContinuityThreadExecutionRef {
  const label = normalizeUserFacingIntentGatewaySummary(ref.label);
  return {
    kind: ref.kind,
    id: ref.id,
    ...(label ? { label } : {}),
  };
}

function cloneSurfaceLink(link: ContinuityThreadSurfaceLink): ContinuityThreadSurfaceLink {
  return { ...link };
}

function cloneContinuationState(
  state: ContinuityThreadContinuationState,
): ContinuityThreadContinuationState {
  return {
    kind: state.kind,
    payload: { ...state.payload },
  };
}

function cloneRecord(record: ContinuityThreadRecord): ContinuityThreadRecord {
  const {
    focusSummary: _ignoredFocusSummary,
    activeExecutionRefs,
    continuationState,
    safeSummary: _ignoredSafeSummary,
    ...rest
  } = record;
  const focusSummary = normalizeUserFacingIntentGatewaySummary(record.focusSummary);
  const safeSummary = normalizeUserFacingIntentGatewaySummary(record.safeSummary);
  return {
    ...rest,
    scope: { ...record.scope },
    linkedSurfaces: record.linkedSurfaces.map(cloneSurfaceLink),
    ...(focusSummary ? { focusSummary } : {}),
    ...(activeExecutionRefs
      ? { activeExecutionRefs: activeExecutionRefs.map(cloneExecutionRef) }
      : {}),
    ...(continuationState
      ? { continuationState: cloneContinuationState(continuationState) }
      : {}),
    ...(safeSummary ? { safeSummary } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(
  value: unknown,
  maxChars: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...` : trimmed;
}

function normalizeSurfaceLink(value: unknown): ContinuityThreadSurfaceLink | null {
  if (!isRecord(value)) return null;
  const channel = typeof value.channel === 'string' ? value.channel.trim() : '';
  const surfaceId = typeof value.surfaceId === 'string' ? value.surfaceId.trim() : '';
  if (!channel || !surfaceId) return null;
  return {
    channel,
    surfaceId,
    active: value.active !== false,
    lastSeenAt: typeof value.lastSeenAt === 'number' && Number.isFinite(value.lastSeenAt)
      ? value.lastSeenAt
      : Date.now(),
  };
}

function normalizeExecutionRef(value: unknown): ContinuityThreadExecutionRef | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const label = normalizeUserFacingIntentGatewaySummary(
    typeof value.label === 'string' ? value.label : undefined,
  );
  if (
    (
      kind !== 'code_session'
      && kind !== 'pending_action'
      && kind !== 'automation'
      && kind !== 'auth_flow'
      && kind !== 'execution'
    )
    || !id
  ) {
    return null;
  }
  return {
    kind,
    id,
    ...(label ? { label } : {}),
  };
}

function normalizeContinuationState(
  value: unknown,
): ContinuityThreadContinuationState | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null;
  const kind = typeof value.kind === 'string' ? value.kind.trim() : '';
  if (!kind) return null;
  return {
    kind: kind.length > 80 ? kind.slice(0, 80).trim() : kind,
    payload: { ...value.payload },
  };
}

function normalizeRecord(value: unknown): ContinuityThreadRecord | null {
  if (!isRecord(value) || !isRecord(value.scope)) return null;
  const assistantId = typeof value.scope.assistantId === 'string' ? value.scope.assistantId.trim() : '';
  const userId = typeof value.scope.userId === 'string' ? value.scope.userId.trim() : '';
  const continuityKey = typeof value.continuityKey === 'string' ? value.continuityKey.trim() : '';
  if (!assistantId || !userId || !continuityKey) return null;
  const linkedSurfaces = Array.isArray(value.linkedSurfaces)
    ? value.linkedSurfaces
      .map(normalizeSurfaceLink)
      .filter((item): item is ContinuityThreadSurfaceLink => !!item)
    : [];
  const activeExecutionRefs = Array.isArray(value.activeExecutionRefs)
    ? value.activeExecutionRefs
      .map(normalizeExecutionRef)
      .filter((item): item is ContinuityThreadExecutionRef => !!item)
    : [];
  const continuationState = normalizeContinuationState(value.continuationState);
  const focusSummary = normalizeUserFacingIntentGatewaySummary(normalizeText(value.focusSummary, 400));
  const safeSummary = normalizeUserFacingIntentGatewaySummary(normalizeText(value.safeSummary, 500));
  return {
    continuityKey,
    scope: { assistantId, userId },
    linkedSurfaces,
    ...(focusSummary ? { focusSummary } : {}),
    ...(normalizeText(value.lastActionableRequest, 800) ? { lastActionableRequest: normalizeText(value.lastActionableRequest, 800) } : {}),
    ...(activeExecutionRefs.length > 0 ? { activeExecutionRefs } : {}),
    ...(continuationState ? { continuationState } : {}),
    ...(safeSummary ? { safeSummary } : {}),
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    expiresAt: typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : Date.now(),
  };
}

function dedupeSurfaceLinks(links: ContinuityThreadSurfaceLink[]): ContinuityThreadSurfaceLink[] {
  const seen = new Map<string, ContinuityThreadSurfaceLink>();
  for (const link of links) {
    const key = `${link.channel}:${link.surfaceId}`;
    const current = seen.get(key);
    if (!current || link.lastSeenAt >= current.lastSeenAt) {
      seen.set(key, cloneSurfaceLink(link));
    }
  }
  return [...seen.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function dedupeExecutionRefs(refs: ContinuityThreadExecutionRef[]): ContinuityThreadExecutionRef[] {
  const seen = new Map<string, ContinuityThreadExecutionRef>();
  for (const ref of refs) {
    seen.set(`${ref.kind}:${ref.id}`, cloneExecutionRef(ref));
  }
  return [...seen.values()];
}

export function summarizeContinuityThreadForGateway(
  record: ContinuityThreadRecord | null | undefined,
): {
  continuityKey: string;
  linkedSurfaceCount: number;
  linkedSurfaces?: string[];
  focusSummary?: string;
  lastActionableRequest?: string;
  activeExecutionRefs?: string[];
  continuationStateKind?: string;
} | null {
  if (!record) return null;
  return {
    continuityKey: record.continuityKey,
    linkedSurfaceCount: record.linkedSurfaces.length,
    ...(record.linkedSurfaces.length > 0
      ? { linkedSurfaces: record.linkedSurfaces.slice(0, 4).map((link) => `${link.channel}:${link.surfaceId}`) }
      : {}),
    ...(record.focusSummary ? { focusSummary: record.focusSummary } : {}),
    ...(record.lastActionableRequest ? { lastActionableRequest: record.lastActionableRequest } : {}),
    ...(record.activeExecutionRefs?.length
      ? {
          activeExecutionRefs: record.activeExecutionRefs.map((ref) =>
            ref.label ? `${ref.kind}:${ref.label}` : `${ref.kind}:${ref.id}`),
        }
      : {}),
    ...(record.continuationState?.kind
      ? { continuationStateKind: record.continuationState.kind }
      : {}),
  };
}

export function toContinuityThreadClientMetadata(
  record: ContinuityThreadRecord | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return {
    continuityKey: record.continuityKey,
    assistantId: record.scope.assistantId,
    userId: record.scope.userId,
    linkedSurfaces: record.linkedSurfaces.map((link) => ({ ...link })),
    ...(record.focusSummary ? { focusSummary: record.focusSummary } : {}),
    ...(record.lastActionableRequest ? { lastActionableRequest: record.lastActionableRequest } : {}),
    ...(record.activeExecutionRefs?.length
      ? { activeExecutionRefs: record.activeExecutionRefs.map((ref) => ({ ...ref })) }
      : {}),
    ...(record.continuationState?.kind
      ? { continuationStateKind: record.continuationState.kind }
      : {}),
    ...(record.safeSummary ? { safeSummary: record.safeSummary } : {}),
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
}

export function formatContinuityThreadForPrompt(
  record: ContinuityThreadRecord | null | undefined,
): string {
  if (!record) return '';
  const lines: string[] = [];
  if (record.focusSummary) {
    lines.push('focusSummary:');
    lines.push(record.focusSummary);
  }
  if (record.lastActionableRequest) {
    lines.push('lastActionableRequest:');
    lines.push(record.lastActionableRequest);
  }
  if (record.activeExecutionRefs?.length) {
    lines.push('activeExecutionRefs:');
    for (const ref of record.activeExecutionRefs) {
      lines.push(`- ${ref.kind}: ${ref.label ?? ref.id}`);
    }
  }
  if (lines.length === 0) return '';
  return `<continuity-context>\n${lines.join('\n')}\n</continuity-context>`;
}

export class ContinuityThreadStore {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly mode: 'sqlite' | 'memory';
  private db: SQLiteDatabase | null = null;
  private readonly records = new Map<string, ContinuityThreadRecord>();
  private securityMonitor: SQLiteSecurityMonitor | null = null;
  private upsertStmt: SQLiteStatement | null = null;
  private rowByKeyStmt: SQLiteStatement | null = null;

  constructor(options: ContinuityThreadStoreOptions) {
    this.now = options.now ?? Date.now;
    this.retentionMs = Math.max(1, options.retentionDays) * 24 * 60 * 60 * 1000;
    if (options.enabled === false || !hasSQLiteDriver()) {
      this.mode = 'memory';
      return;
    }
    try {
      mkdirSync(dirname(options.sqlitePath), { recursive: true });
      this.db = openSQLiteDatabase(options.sqlitePath, { enableForeignKeyConstraints: true });
      if (!this.db) {
        this.mode = 'memory';
        return;
      }
      this.mode = 'sqlite';
      this.initializeSchema();
      this.securityMonitor = new SQLiteSecurityMonitor({
        service: 'continuity_threads',
        db: this.db,
        sqlitePath: options.sqlitePath,
        onEvent: options.onSecurityEvent,
        now: this.now,
      });
      this.securityMonitor.initialize();
    } catch {
      this.mode = 'memory';
      this.db = null;
    }
  }

  private initializeSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_threads (
        continuity_key TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS continuity_threads_scope_idx
        ON continuity_threads(assistant_id, user_id, updated_at DESC);
    `);
    this.upsertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO continuity_threads (
        continuity_key, assistant_id, user_id, updated_at, expires_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.rowByKeyStmt = this.db.prepare(`
      SELECT *
      FROM continuity_threads
      WHERE continuity_key = ?
      LIMIT 1
    `);
  }

  private deserializeRow(row: StoredContinuityThreadRow): ContinuityThreadRecord | null {
    try {
      return normalizeRecord(JSON.parse(row.payload_json) as unknown);
    } catch {
      return null;
    }
  }

  private persist(record: ContinuityThreadRecord): void {
    const normalized = cloneRecord(record);
    if (this.mode === 'sqlite' && this.upsertStmt) {
      this.upsertStmt.run(
        normalized.continuityKey,
        normalized.scope.assistantId,
        normalized.scope.userId,
        normalized.updatedAt,
        normalized.expiresAt,
        JSON.stringify(normalized),
      );
      this.securityMonitor?.maybeCheck();
      return;
    }
    this.records.set(normalized.continuityKey, normalized);
  }

  private remove(continuityKey: string): void {
    if (this.mode === 'sqlite' && this.db) {
      this.db.prepare(`
        DELETE FROM continuity_threads
        WHERE continuity_key = ?
      `).run(continuityKey);
      return;
    }
    this.records.delete(continuityKey);
  }

  get(scope: ContinuityThreadScope, nowMs: number = this.now()): ContinuityThreadRecord | null {
    const continuityKey = buildContinuityKey(scope);
    const sqliteRow = this.mode === 'sqlite' && this.rowByKeyStmt
      ? this.rowByKeyStmt.get(continuityKey) as StoredContinuityThreadRow | undefined
      : undefined;
    const record = this.mode === 'sqlite' && this.rowByKeyStmt
      ? (sqliteRow ? this.deserializeRow(sqliteRow) : null)
      : this.records.get(continuityKey) ?? null;
    if (!record) return null;
    if (record.expiresAt <= nowMs) {
      this.remove(continuityKey);
      return null;
    }
    return cloneRecord(record);
  }

  upsert(
    scope: ContinuityThreadScope,
    input: ContinuityThreadUpsertInput,
    nowMs: number = this.now(),
  ): ContinuityThreadRecord {
    const existing = this.get(scope, nowMs);
    const continuityKey = existing?.continuityKey ?? buildContinuityKey(scope);
    const linkedSurfaces = dedupeSurfaceLinks([
      ...(existing?.linkedSurfaces ?? []),
      ...(input.touchSurface
        ? [{
            channel: input.touchSurface.channel.trim(),
            surfaceId: input.touchSurface.surfaceId.trim(),
            active: true,
            lastSeenAt: nowMs,
          }]
        : []),
    ].filter((item) => item.channel && item.surfaceId));
    const activeExecutionRefs = input.activeExecutionRefs === null
      ? undefined
      : input.activeExecutionRefs
        ? dedupeExecutionRefs(input.activeExecutionRefs.map(cloneExecutionRef))
        : existing?.activeExecutionRefs
          ? existing.activeExecutionRefs.map(cloneExecutionRef)
          : undefined;
    const continuationState = input.continuationState === null
      ? undefined
      : input.continuationState
        ? normalizeContinuationState(input.continuationState)
        : existing?.continuationState
          ? cloneContinuationState(existing.continuationState)
          : undefined;
    const focusSummary = input.focusSummary === null
      ? undefined
      : (input.focusSummary !== undefined
          ? normalizeText(input.focusSummary, 400)
          : existing?.focusSummary);
    const lastActionableRequest = input.lastActionableRequest === null
      ? undefined
      : (input.lastActionableRequest !== undefined
          ? normalizeText(input.lastActionableRequest, 800)
          : existing?.lastActionableRequest);
    const safeSummary = input.safeSummary === null
      ? undefined
      : (input.safeSummary !== undefined
          ? normalizeText(input.safeSummary, 500)
          : existing?.safeSummary);
    const record: ContinuityThreadRecord = {
      continuityKey,
      scope: { ...scope },
      linkedSurfaces,
      ...(focusSummary ? { focusSummary } : {}),
      ...(lastActionableRequest ? { lastActionableRequest } : {}),
      ...(activeExecutionRefs?.length ? { activeExecutionRefs } : {}),
      ...(continuationState ? { continuationState } : {}),
      ...(safeSummary ? { safeSummary } : {}),
      createdAt: existing?.createdAt ?? nowMs,
      updatedAt: nowMs,
      expiresAt: nowMs + this.retentionMs,
    };
    this.persist(record);
    return cloneRecord(record);
  }
}
