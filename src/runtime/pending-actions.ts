import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SQLiteSecurityMonitor, type SQLiteSecurityEvent } from './sqlite-security.js';
import {
  hasSQLiteDriver,
  openSQLiteDatabase,
  type SQLiteDatabase,
  type SQLiteStatement,
} from './sqlite-driver.js';

export type PendingActionStatus =
  | 'pending'
  | 'resolving'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export type PendingActionBlockerKind =
  | 'approval'
  | 'clarification'
  | 'workspace_switch'
  | 'auth'
  | 'policy'
  | 'missing_context';

export type PendingActionResumeKind =
  | 'direct_route'
  | 'tool_loop'
  | 'playbook_run';

export type PendingActionTransferPolicy =
  | 'origin_surface_only'
  | 'linked_surfaces_same_user'
  | 'explicit_takeover_only';

export interface PendingActionScope {
  agentId: string;
  userId: string;
  channel: string;
  surfaceId: string;
}

export interface PendingActionOption {
  value: string;
  label: string;
  description?: string;
}

export interface PendingActionApprovalSummary {
  id: string;
  toolName: string;
  argsPreview: string;
}

export interface PendingActionIntent {
  route?: string;
  operation?: string;
  summary?: string;
  turnRelation?: string;
  resolution?: string;
  missingFields?: string[];
  originalUserContent: string;
  resolvedContent?: string;
  entities?: Record<string, unknown>;
}

export interface PendingActionBlocker {
  kind: PendingActionBlockerKind;
  prompt: string;
  field?: string;
  provider?: string;
  service?: string;
  options?: PendingActionOption[];
  approvalIds?: string[];
  approvalSummaries?: PendingActionApprovalSummary[];
  currentSessionId?: string;
  currentSessionLabel?: string;
  targetSessionId?: string;
  targetSessionLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface PendingActionResume {
  kind: PendingActionResumeKind;
  payload: Record<string, unknown>;
}

export interface PendingActionRecord {
  id: string;
  scope: PendingActionScope;
  status: PendingActionStatus;
  transferPolicy: PendingActionTransferPolicy;
  blocker: PendingActionBlocker;
  intent: PendingActionIntent;
  resume?: PendingActionResume;
  codeSessionId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface PendingActionStoreOptions {
  enabled?: boolean;
  sqlitePath: string;
  now?: () => number;
  onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
}

interface StoredPendingActionRow {
  id: string;
  agent_id: string;
  user_id: string;
  channel: string;
  surface_id: string;
  status: string;
  blocker_kind: string;
  code_session_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  payload_json: string;
}

interface MemoryStore {
  records: Map<string, PendingActionRecord>;
}

function buildScopeKey(scope: PendingActionScope): string {
  return `${scope.agentId}:${scope.userId}:${scope.channel}:${scope.surfaceId}`;
}

export function isPendingActionActive(status: PendingActionStatus): boolean {
  return status === 'pending' || status === 'resolving' || status === 'running';
}

function cloneRecord(record: PendingActionRecord): PendingActionRecord {
  return {
    ...record,
    scope: { ...record.scope },
    transferPolicy: record.transferPolicy,
    blocker: cloneBlocker(record.blocker),
    intent: cloneIntent(record.intent),
    ...(record.resume
      ? {
          resume: {
            kind: record.resume.kind,
            payload: { ...record.resume.payload },
          },
        }
      : {}),
  };
}

function cloneBlocker(blocker: PendingActionBlocker): PendingActionBlocker {
  return {
    ...blocker,
    ...(blocker.options ? { options: blocker.options.map((option) => ({ ...option })) } : {}),
    ...(blocker.approvalIds ? { approvalIds: [...blocker.approvalIds] } : {}),
    ...(blocker.approvalSummaries ? { approvalSummaries: blocker.approvalSummaries.map((item) => ({ ...item })) } : {}),
    ...(blocker.metadata ? { metadata: { ...blocker.metadata } } : {}),
  };
}

function cloneIntent(intent: PendingActionIntent): PendingActionIntent {
  return {
    ...intent,
    ...(intent.missingFields ? { missingFields: [...intent.missingFields] } : {}),
    ...(intent.entities ? { entities: { ...intent.entities } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(value: unknown): PendingActionStatus {
  switch (value) {
    case 'pending':
    case 'resolving':
    case 'running':
    case 'completed':
    case 'cancelled':
    case 'expired':
    case 'failed':
      return value;
    default:
      return 'pending';
  }
}

function normalizeBlockerKind(value: unknown): PendingActionBlockerKind {
  switch (value) {
    case 'approval':
    case 'clarification':
    case 'workspace_switch':
    case 'auth':
    case 'policy':
    case 'missing_context':
      return value;
    default:
      return 'clarification';
  }
}

function normalizeResumeKind(value: unknown): PendingActionResumeKind | undefined {
  switch (value) {
    case 'direct_route':
    case 'tool_loop':
    case 'playbook_run':
      return value;
    default:
      return undefined;
  }
}

export function defaultPendingActionTransferPolicy(
  blockerKind: PendingActionBlockerKind,
): PendingActionTransferPolicy {
  switch (blockerKind) {
    case 'approval':
    case 'policy':
      return 'origin_surface_only';
    case 'clarification':
    case 'workspace_switch':
    case 'auth':
    case 'missing_context':
      return 'linked_surfaces_same_user';
    default:
      return 'origin_surface_only';
  }
}

function normalizeTransferPolicy(
  value: unknown,
  blockerKind: PendingActionBlockerKind,
): PendingActionTransferPolicy {
  switch (value) {
    case 'origin_surface_only':
    case 'linked_surfaces_same_user':
    case 'explicit_takeover_only':
      return value;
    default:
      return defaultPendingActionTransferPolicy(blockerKind);
  }
}

function normalizeRecord(value: unknown): PendingActionRecord | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.scope) || !isRecord(value.blocker) || !isRecord(value.intent)) return null;
  const agentId = typeof value.scope.agentId === 'string' ? value.scope.agentId.trim() : '';
  const userId = typeof value.scope.userId === 'string' ? value.scope.userId.trim() : '';
  const channel = typeof value.scope.channel === 'string' ? value.scope.channel.trim() : '';
  const surfaceId = typeof value.scope.surfaceId === 'string' ? value.scope.surfaceId.trim() : '';
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const prompt = typeof value.blocker.prompt === 'string' ? value.blocker.prompt.trim() : '';
  const originalUserContent = typeof value.intent.originalUserContent === 'string'
    ? value.intent.originalUserContent
    : '';
  if (!id || !agentId || !userId || !channel || !surfaceId || !prompt || !originalUserContent) {
    return null;
  }

  const options = Array.isArray(value.blocker.options)
    ? value.blocker.options
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        value: typeof item.value === 'string' ? item.value.trim() : '',
        label: typeof item.label === 'string' ? item.label.trim() : '',
        ...(typeof item.description === 'string' && item.description.trim()
          ? { description: item.description.trim() }
          : {}),
      }))
      .filter((item) => item.value && item.label)
    : undefined;
  const approvalIds = Array.isArray(value.blocker.approvalIds)
    ? value.blocker.approvalIds.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : undefined;
  const approvalSummaries = Array.isArray(value.blocker.approvalSummaries)
    ? value.blocker.approvalSummaries
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id.trim() : '',
        toolName: typeof item.toolName === 'string' ? item.toolName.trim() : '',
        argsPreview: typeof item.argsPreview === 'string' ? item.argsPreview : '',
      }))
      .filter((item) => item.id && item.toolName)
    : undefined;

  const blockerKind = normalizeBlockerKind(value.blocker.kind);

  return {
    id,
    scope: {
      agentId,
      userId,
      channel,
      surfaceId,
    },
    status: normalizeStatus(value.status),
    transferPolicy: normalizeTransferPolicy(value.transferPolicy, blockerKind),
    blocker: {
      kind: blockerKind,
      prompt,
      ...(typeof value.blocker.field === 'string' && value.blocker.field.trim() ? { field: value.blocker.field.trim() } : {}),
      ...(typeof value.blocker.provider === 'string' && value.blocker.provider.trim() ? { provider: value.blocker.provider.trim() } : {}),
      ...(typeof value.blocker.service === 'string' && value.blocker.service.trim() ? { service: value.blocker.service.trim() } : {}),
      ...(options && options.length > 0 ? { options } : {}),
      ...(approvalIds && approvalIds.length > 0 ? { approvalIds } : {}),
      ...(approvalSummaries && approvalSummaries.length > 0 ? { approvalSummaries } : {}),
      ...(typeof value.blocker.currentSessionId === 'string' && value.blocker.currentSessionId.trim()
        ? { currentSessionId: value.blocker.currentSessionId.trim() }
        : {}),
      ...(typeof value.blocker.currentSessionLabel === 'string' && value.blocker.currentSessionLabel.trim()
        ? { currentSessionLabel: value.blocker.currentSessionLabel.trim() }
        : {}),
      ...(typeof value.blocker.targetSessionId === 'string' && value.blocker.targetSessionId.trim()
        ? { targetSessionId: value.blocker.targetSessionId.trim() }
        : {}),
      ...(typeof value.blocker.targetSessionLabel === 'string' && value.blocker.targetSessionLabel.trim()
        ? { targetSessionLabel: value.blocker.targetSessionLabel.trim() }
        : {}),
      ...(isRecord(value.blocker.metadata) ? { metadata: { ...value.blocker.metadata } } : {}),
    },
    intent: {
      ...(typeof value.intent.route === 'string' && value.intent.route.trim() ? { route: value.intent.route.trim() } : {}),
      ...(typeof value.intent.operation === 'string' && value.intent.operation.trim() ? { operation: value.intent.operation.trim() } : {}),
      ...(typeof value.intent.summary === 'string' && value.intent.summary.trim() ? { summary: value.intent.summary.trim() } : {}),
      ...(typeof value.intent.turnRelation === 'string' && value.intent.turnRelation.trim() ? { turnRelation: value.intent.turnRelation.trim() } : {}),
      ...(typeof value.intent.resolution === 'string' && value.intent.resolution.trim() ? { resolution: value.intent.resolution.trim() } : {}),
      ...(Array.isArray(value.intent.missingFields)
        ? {
            missingFields: value.intent.missingFields
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {}),
      originalUserContent,
      ...(typeof value.intent.resolvedContent === 'string' && value.intent.resolvedContent.trim()
        ? { resolvedContent: value.intent.resolvedContent.trim() }
        : {}),
      ...(isRecord(value.intent.entities) ? { entities: { ...value.intent.entities } } : {}),
    },
    ...(isRecord(value.resume) && normalizeResumeKind(value.resume.kind)
      ? {
          resume: {
            kind: normalizeResumeKind(value.resume.kind)!,
            payload: isRecord(value.resume.payload) ? { ...value.resume.payload } : {},
          },
        }
      : {}),
    ...(typeof value.codeSessionId === 'string' && value.codeSessionId.trim() ? { codeSessionId: value.codeSessionId.trim() } : {}),
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    expiresAt: typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : Date.now(),
  };
}

export function summarizePendingActionForGateway(
  record: PendingActionRecord | null | undefined,
): {
  id: string;
  status: PendingActionStatus;
  blockerKind: PendingActionBlockerKind;
  transferPolicy: PendingActionTransferPolicy;
  prompt: string;
  originalRequest: string;
  route?: string;
  operation?: string;
  field?: string;
} | null {
  if (!record || !isPendingActionActive(record.status)) return null;
  return {
    id: record.id,
    status: record.status,
    blockerKind: record.blocker.kind,
    transferPolicy: record.transferPolicy,
    prompt: record.blocker.prompt,
    originalRequest: record.intent.originalUserContent,
    ...(record.intent.route ? { route: record.intent.route } : {}),
    ...(record.intent.operation ? { operation: record.intent.operation } : {}),
    ...(record.blocker.field ? { field: record.blocker.field } : {}),
  };
}

export function toPendingActionClientMetadata(
  record: PendingActionRecord | null | undefined,
): Record<string, unknown> | undefined {
  if (!record || !isPendingActionActive(record.status)) return undefined;
  return {
    id: record.id,
    status: record.status,
    expiresAt: record.expiresAt,
    transferPolicy: record.transferPolicy,
    origin: {
      channel: record.scope.channel,
      surfaceId: record.scope.surfaceId,
    },
    ...(record.codeSessionId ? { codeSessionId: record.codeSessionId } : {}),
    blocker: {
      kind: record.blocker.kind,
      prompt: record.blocker.prompt,
      ...(record.blocker.field ? { field: record.blocker.field } : {}),
      ...(record.blocker.provider ? { provider: record.blocker.provider } : {}),
      ...(record.blocker.service ? { service: record.blocker.service } : {}),
      ...(record.blocker.options?.length ? { options: record.blocker.options.map((item) => ({ ...item })) } : {}),
      ...(record.blocker.approvalIds?.length ? { approvalIds: [...record.blocker.approvalIds] } : {}),
      ...(record.blocker.approvalSummaries?.length ? { approvalSummaries: record.blocker.approvalSummaries.map((item) => ({ ...item })) } : {}),
      ...(record.blocker.currentSessionId ? { currentSessionId: record.blocker.currentSessionId } : {}),
      ...(record.blocker.currentSessionLabel ? { currentSessionLabel: record.blocker.currentSessionLabel } : {}),
      ...(record.blocker.targetSessionId ? { targetSessionId: record.blocker.targetSessionId } : {}),
      ...(record.blocker.targetSessionLabel ? { targetSessionLabel: record.blocker.targetSessionLabel } : {}),
      ...(record.blocker.metadata ? { metadata: { ...record.blocker.metadata } } : {}),
    },
    intent: {
      ...(record.intent.route ? { route: record.intent.route } : {}),
      ...(record.intent.operation ? { operation: record.intent.operation } : {}),
      ...(record.intent.summary ? { summary: record.intent.summary } : {}),
      ...(record.intent.turnRelation ? { turnRelation: record.intent.turnRelation } : {}),
      ...(record.intent.resolution ? { resolution: record.intent.resolution } : {}),
      ...(record.intent.missingFields?.length ? { missingFields: [...record.intent.missingFields] } : {}),
      originalUserContent: record.intent.originalUserContent,
      ...(record.intent.resolvedContent ? { resolvedContent: record.intent.resolvedContent } : {}),
      ...(record.intent.entities ? { entities: { ...record.intent.entities } } : {}),
    },
  };
}

export class PendingActionStore {
  private readonly now: () => number;
  private readonly mode: 'sqlite' | 'memory';
  private db: SQLiteDatabase | null = null;
  private readonly memory: MemoryStore = {
    records: new Map(),
  };
  private securityMonitor: SQLiteSecurityMonitor | null = null;
  private insertOrReplaceStmt: SQLiteStatement | null = null;
  private rowByIdStmt: SQLiteStatement | null = null;
  private scopeRowsStmt: SQLiteStatement | null = null;
  private userRowsStmt: SQLiteStatement | null = null;

  constructor(options: PendingActionStoreOptions) {
    this.now = options.now ?? Date.now;
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
        service: 'pending_actions',
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
      CREATE TABLE IF NOT EXISTS pending_actions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        status TEXT NOT NULL,
        blocker_kind TEXT NOT NULL,
        code_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_actions_scope_idx
        ON pending_actions(agent_id, user_id, channel, surface_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS pending_actions_status_idx
        ON pending_actions(status, expires_at, updated_at DESC);
    `);
    this.insertOrReplaceStmt = this.db.prepare(`
      INSERT OR REPLACE INTO pending_actions (
        id, agent_id, user_id, channel, surface_id, status, blocker_kind, code_session_id,
        created_at, updated_at, expires_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.scopeRowsStmt = this.db.prepare(`
      SELECT *
      FROM pending_actions
      WHERE agent_id = ? AND user_id = ? AND channel = ? AND surface_id = ?
      ORDER BY updated_at DESC
    `);
    this.rowByIdStmt = this.db.prepare(`
      SELECT *
      FROM pending_actions
      WHERE id = ?
      LIMIT 1
    `);
    this.userRowsStmt = this.db.prepare(`
      SELECT *
      FROM pending_actions
      WHERE agent_id = ? AND user_id = ?
      ORDER BY updated_at DESC
    `);
  }

  private listAllRecords(nowMs: number): PendingActionRecord[] {
    const rows = this.mode === 'sqlite' && this.db && this.db.prepare
      ? this.db.prepare(`
          SELECT *
          FROM pending_actions
          ORDER BY updated_at DESC
        `).all() as StoredPendingActionRow[]
      : [...this.memory.records.values()].map((record) => ({
          id: record.id,
          agent_id: record.scope.agentId,
          user_id: record.scope.userId,
          channel: record.scope.channel,
          surface_id: record.scope.surfaceId,
          status: record.status,
          blocker_kind: record.blocker.kind,
          code_session_id: record.codeSessionId ?? null,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          expires_at: record.expiresAt,
          payload_json: JSON.stringify(record),
        }));
    const parsed: PendingActionRecord[] = [];
    for (const row of rows) {
      const record = this.deserializeRow(row);
      if (!record) continue;
      if (record.expiresAt <= nowMs && isPendingActionActive(record.status)) {
        const expired = this.update(record.id, { status: 'expired' }, nowMs);
        if (expired) parsed.push(expired);
        continue;
      }
      parsed.push(record);
    }
    return parsed;
  }

  private deserializeRow(row: StoredPendingActionRow): PendingActionRecord | null {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      const record = normalizeRecord(parsed);
      if (!record) return null;
      return record;
    } catch {
      return null;
    }
  }

  private getStoredRecord(id: string): PendingActionRecord | null {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    if (this.mode === 'sqlite' && this.rowByIdStmt) {
      const row = this.rowByIdStmt.get(normalizedId) as StoredPendingActionRow | undefined;
      return row ? this.deserializeRow(row) : null;
    }
    return this.memory.records.get(normalizedId) ?? null;
  }

  private listStoredRecordsForAssistantUser(
    agentId: string,
    userId: string,
    nowMs: number,
  ): PendingActionRecord[] {
    const normalizedAgentId = agentId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedAgentId || !normalizedUserId) return [];
    const rows = this.mode === 'sqlite' && this.userRowsStmt
      ? this.userRowsStmt.all(normalizedAgentId, normalizedUserId) as StoredPendingActionRow[]
      : [...this.memory.records.values()]
        .filter((record) => record.scope.agentId === normalizedAgentId && record.scope.userId === normalizedUserId)
        .map((record) => ({
          id: record.id,
          agent_id: record.scope.agentId,
          user_id: record.scope.userId,
          channel: record.scope.channel,
          surface_id: record.scope.surfaceId,
          status: record.status,
          blocker_kind: record.blocker.kind,
          code_session_id: record.codeSessionId ?? null,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          expires_at: record.expiresAt,
          payload_json: JSON.stringify(record),
        }));
    const parsed = rows
      .map((row) => this.deserializeRow(row))
      .filter((record): record is PendingActionRecord => Boolean(record))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const result: PendingActionRecord[] = [];
    for (const record of parsed) {
      if (record.expiresAt <= nowMs && isPendingActionActive(record.status)) {
        const expired = this.update(record.id, { status: 'expired' }, nowMs);
        if (expired) result.push(expired);
        continue;
      }
      result.push(cloneRecord(record));
    }
    return result;
  }

  private persist(record: PendingActionRecord): PendingActionRecord {
    const cloned = cloneRecord(record);
    if (this.mode === 'memory' || !this.insertOrReplaceStmt) {
      this.memory.records.set(cloned.id, cloned);
      return cloneRecord(cloned);
    }
    this.insertOrReplaceStmt.run(
      cloned.id,
      cloned.scope.agentId,
      cloned.scope.userId,
      cloned.scope.channel,
      cloned.scope.surfaceId,
      cloned.status,
      cloned.blocker.kind,
      cloned.codeSessionId ?? null,
      cloned.createdAt,
      cloned.updatedAt,
      cloned.expiresAt,
      JSON.stringify(cloned),
    );
    return cloneRecord(cloned);
  }

  get(id: string, nowMs: number = this.now()): PendingActionRecord | null {
    const record = this.getStoredRecord(id);
    if (!record) return null;
    if (record.expiresAt <= nowMs && isPendingActionActive(record.status)) {
      return this.update(record.id, { status: 'expired' }, nowMs);
    }
    return cloneRecord(record);
  }

  getActive(scope: PendingActionScope, nowMs: number = this.now()): PendingActionRecord | null {
    const records = this.listForScope(scope, nowMs);
    return records.find((record) => isPendingActionActive(record.status)) ?? null;
  }

  resolveActiveForSurface(scope: PendingActionScope, nowMs: number = this.now()): PendingActionRecord | null {
    const primary = this.getActive(scope, nowMs);
    if (primary) return primary;
    if (scope.surfaceId !== scope.userId) {
      const alias = this.getActive({
        ...scope,
        surfaceId: scope.userId,
      }, nowMs);
      if (alias) return alias;
    }
    const portable = this.listStoredRecordsForAssistantUser(scope.agentId, scope.userId, nowMs)
      .find((record) =>
        isPendingActionActive(record.status)
        && record.transferPolicy === 'linked_surfaces_same_user'
        && !(record.scope.channel === scope.channel && record.scope.surfaceId === scope.surfaceId));
    return portable ? cloneRecord(portable) : null;
  }

  listForScope(scope: PendingActionScope, nowMs: number = this.now()): PendingActionRecord[] {
    const rows = this.mode === 'sqlite' && this.scopeRowsStmt
      ? this.scopeRowsStmt.all(
          scope.agentId,
          scope.userId,
          scope.channel,
          scope.surfaceId,
        ) as StoredPendingActionRow[]
      : [...this.memory.records.values()]
        .filter((record) => buildScopeKey(record.scope) === buildScopeKey(scope))
        .map((record) => ({
          id: record.id,
          agent_id: record.scope.agentId,
          user_id: record.scope.userId,
          channel: record.scope.channel,
          surface_id: record.scope.surfaceId,
          status: record.status,
          blocker_kind: record.blocker.kind,
          code_session_id: record.codeSessionId ?? null,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          expires_at: record.expiresAt,
          payload_json: JSON.stringify(record),
        }));
    const parsed = rows
      .map((row) => this.deserializeRow(row))
      .filter((record): record is PendingActionRecord => Boolean(record))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const result: PendingActionRecord[] = [];
    for (const record of parsed) {
      if (record.expiresAt <= nowMs && isPendingActionActive(record.status)) {
        const expired = this.update(record.id, { status: 'expired' }, nowMs);
        if (expired) result.push(expired);
        continue;
      }
      result.push(cloneRecord(record));
    }
    return result;
  }

  replaceActive(
    scope: PendingActionScope,
    input: Omit<PendingActionRecord, 'id' | 'createdAt' | 'updatedAt' | 'scope'> & { id?: string },
    nowMs: number = this.now(),
  ): PendingActionRecord {
    const existing = this.getActive(scope, nowMs);
    if (existing && existing.id !== input.id) {
      this.update(existing.id, { status: 'cancelled' }, nowMs);
    }
    const record: PendingActionRecord = {
      id: input.id?.trim() || randomUUID(),
      scope: { ...scope },
      status: input.status,
      transferPolicy: input.transferPolicy,
      blocker: cloneBlocker(input.blocker),
      intent: cloneIntent(input.intent),
      createdAt: existing?.createdAt ?? nowMs,
      updatedAt: nowMs,
      expiresAt: input.expiresAt,
    };
    if (input.resume) {
      record.resume = { kind: input.resume.kind, payload: { ...input.resume.payload } };
    }
    if (input.codeSessionId?.trim()) {
      record.codeSessionId = input.codeSessionId.trim();
    }
    return this.persist(record);
  }

  update(
    id: string,
    patch: Partial<Omit<PendingActionRecord, 'id' | 'scope' | 'createdAt'>> & { scope?: PendingActionScope },
    nowMs: number = this.now(),
  ): PendingActionRecord | null {
    const existing = this.getStoredRecord(id);
    if (!existing) return null;
    const next: PendingActionRecord = {
      ...existing,
      ...(patch.scope ? { scope: { ...patch.scope } } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.transferPolicy ? { transferPolicy: patch.transferPolicy } : {}),
      ...(patch.blocker ? { blocker: cloneBlocker(patch.blocker) } : {}),
      ...(patch.intent ? { intent: cloneIntent(patch.intent) } : {}),
      ...(patch.resume !== undefined
        ? {
            ...(patch.resume
              ? { resume: { kind: patch.resume.kind, payload: { ...patch.resume.payload } } }
              : { resume: undefined })
          }
        : {}),
      ...(patch.codeSessionId !== undefined
        ? (patch.codeSessionId ? { codeSessionId: patch.codeSessionId } : { codeSessionId: undefined })
        : {}),
      ...(patch.expiresAt ? { expiresAt: patch.expiresAt } : {}),
      updatedAt: nowMs,
    };
    return this.persist(next);
  }

  complete(id: string, nowMs: number = this.now()): PendingActionRecord | null {
    return this.update(id, { status: 'completed' }, nowMs);
  }

  cancel(id: string, nowMs: number = this.now()): PendingActionRecord | null {
    return this.update(id, { status: 'cancelled' }, nowMs);
  }

  findActiveByApprovalId(approvalId: string, nowMs: number = this.now()): PendingActionRecord | null {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return null;
    const active = this.listAllRecords(nowMs)
      .filter((record) => isPendingActionActive(record.status))
      .find((record) => record.blocker.approvalIds?.includes(normalizedId));
    return active ? cloneRecord(active) : null;
  }
}

export function clearApprovalIdFromPendingAction(
  store: PendingActionStore,
  approvalId: string,
  nowMs: number = Date.now(),
): PendingActionRecord | null {
  const normalizedId = approvalId.trim();
  const active = store.findActiveByApprovalId(normalizedId, nowMs);
  if (!active) return null;
  const remainingApprovalIds = (active.blocker.approvalIds ?? []).filter((id) => id !== normalizedId);
  if (remainingApprovalIds.length === 0) {
    return store.complete(active.id, nowMs);
  }
  const remainingSummaries = (active.blocker.approvalSummaries ?? [])
    .filter((summary) => summary.id !== normalizedId);
  return store.update(active.id, {
    blocker: {
      ...active.blocker,
      approvalIds: remainingApprovalIds,
      approvalSummaries: remainingSummaries,
    },
  }, nowMs);
}
