import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  PendingActionApprovalSummary,
  PendingActionBlockerKind,
  PendingActionOption,
} from './pending-actions.js';
import { normalizeUserFacingIntentGatewaySummary } from './intent/summary.js';
import { SQLiteSecurityMonitor, type SQLiteSecurityEvent } from './sqlite-security.js';
import {
  hasSQLiteDriver,
  openSQLiteDatabase,
  type SQLiteDatabase,
  type SQLiteStatement,
} from './sqlite-driver.js';
import type { IntentGatewayDecisionProvenance } from './intent/types.js';

export type ExecutionStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExecutionScope {
  assistantId: string;
  userId: string;
  channel: string;
  surfaceId: string;
  codeSessionId?: string;
  continuityKey?: string;
}

export interface ExecutionIntent {
  route?: string;
  operation?: string;
  summary?: string;
  turnRelation?: string;
  resolution?: string;
  missingFields?: string[];
  originalUserContent: string;
  resolvedContent?: string;
  provenance?: IntentGatewayDecisionProvenance;
  entities?: Record<string, unknown>;
}

export interface ExecutionBlocker {
  pendingActionId?: string;
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
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export interface ExecutionRecord {
  executionId: string;
  requestId: string;
  parentExecutionId?: string;
  rootExecutionId: string;
  retryOfExecutionId?: string;
  scope: ExecutionScope;
  status: ExecutionStatus;
  intent: ExecutionIntent;
  blocker?: ExecutionBlocker;
  lastUserContent?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  failedAt?: number;
}

export interface ExecutionStoreOptions {
  enabled?: boolean;
  sqlitePath: string;
  now?: () => number;
  onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
}

interface StoredExecutionRow {
  execution_id: string;
  assistant_id: string;
  user_id: string;
  channel: string;
  surface_id: string;
  status: string;
  root_execution_id: string;
  request_id: string;
  updated_at: number;
  payload_json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown, maxChars = 1000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
    : trimmed;
}

function cloneOption(option: PendingActionOption): PendingActionOption {
  return { ...option };
}

function cloneApprovalSummary(summary: PendingActionApprovalSummary): PendingActionApprovalSummary {
  return { ...summary };
}

function cloneIntent(intent: ExecutionIntent): ExecutionIntent {
  const {
    summary: _ignoredSummary,
    missingFields,
    provenance,
    entities,
    ...rest
  } = intent;
  const summary = normalizeUserFacingIntentGatewaySummary(intent.summary);
  return {
    ...rest,
    ...(summary ? { summary } : {}),
    ...(missingFields ? { missingFields: [...missingFields] } : {}),
    ...(provenance
      ? {
          provenance: {
            ...provenance,
            ...(provenance.entities ? { entities: { ...provenance.entities } } : {}),
          },
        }
      : {}),
    ...(entities ? { entities: { ...entities } } : {}),
  };
}

function cloneBlocker(blocker: ExecutionBlocker): ExecutionBlocker {
  return {
    ...blocker,
    ...(blocker.options ? { options: blocker.options.map(cloneOption) } : {}),
    ...(blocker.approvalIds ? { approvalIds: [...blocker.approvalIds] } : {}),
    ...(blocker.approvalSummaries
      ? { approvalSummaries: blocker.approvalSummaries.map(cloneApprovalSummary) }
      : {}),
    ...(blocker.metadata ? { metadata: { ...blocker.metadata } } : {}),
  };
}

function cloneRecord(record: ExecutionRecord): ExecutionRecord {
  return {
    ...record,
    scope: { ...record.scope },
    intent: cloneIntent(record.intent),
    ...(record.blocker ? { blocker: cloneBlocker(record.blocker) } : {}),
  };
}

function normalizeStatus(value: unknown): ExecutionStatus {
  switch (value) {
    case 'running':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'running';
  }
}

function normalizeScope(value: unknown): ExecutionScope | null {
  if (!isRecord(value)) return null;
  const assistantId = normalizeText(value.assistantId, 200);
  const userId = normalizeText(value.userId, 200);
  const channel = normalizeText(value.channel, 80);
  const surfaceId = normalizeText(value.surfaceId, 200);
  if (!assistantId || !userId || !channel || !surfaceId) {
    return null;
  }
  return {
    assistantId,
    userId,
    channel,
    surfaceId,
    ...(normalizeText(value.codeSessionId, 200) ? { codeSessionId: normalizeText(value.codeSessionId, 200) } : {}),
    ...(normalizeText(value.continuityKey, 200) ? { continuityKey: normalizeText(value.continuityKey, 200) } : {}),
  };
}

function normalizeIntent(value: unknown): ExecutionIntent | null {
  if (!isRecord(value)) return null;
  const originalUserContent = normalizeText(value.originalUserContent, 4000);
  if (!originalUserContent) return null;
  const summary = normalizeUserFacingIntentGatewaySummary(normalizeText(value.summary, 400));
  return {
    originalUserContent,
    ...(normalizeText(value.route, 120) ? { route: normalizeText(value.route, 120) } : {}),
    ...(normalizeText(value.operation, 120) ? { operation: normalizeText(value.operation, 120) } : {}),
    ...(summary ? { summary } : {}),
    ...(normalizeText(value.turnRelation, 80) ? { turnRelation: normalizeText(value.turnRelation, 80) } : {}),
    ...(normalizeText(value.resolution, 80) ? { resolution: normalizeText(value.resolution, 80) } : {}),
    ...(Array.isArray(value.missingFields)
      ? {
          missingFields: value.missingFields
            .filter((field): field is string => typeof field === 'string')
            .map((field) => field.trim())
            .filter(Boolean),
        }
      : {}),
    ...(normalizeText(value.resolvedContent, 4000) ? { resolvedContent: normalizeText(value.resolvedContent, 4000) } : {}),
    ...(isRecord(value.provenance)
      ? {
          provenance: {
            ...value.provenance,
            ...(isRecord(value.provenance.entities) ? { entities: { ...value.provenance.entities } } : {}),
          } as IntentGatewayDecisionProvenance,
        }
      : {}),
    ...(isRecord(value.entities) ? { entities: { ...value.entities } } : {}),
  };
}

function normalizeBlocker(value: unknown): ExecutionBlocker | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (
    kind !== 'approval'
    && kind !== 'clarification'
    && kind !== 'workspace_switch'
    && kind !== 'auth'
    && kind !== 'policy'
    && kind !== 'missing_context'
  ) {
    return null;
  }
  const prompt = normalizeText(value.prompt, 2000);
  if (!prompt) return null;
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    ? value.createdAt
    : Date.now();
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    ? value.updatedAt
    : createdAt;
  return {
    kind,
    prompt,
    createdAt,
    updatedAt,
    ...(normalizeText(value.pendingActionId, 200) ? { pendingActionId: normalizeText(value.pendingActionId, 200) } : {}),
    ...(normalizeText(value.field, 120) ? { field: normalizeText(value.field, 120) } : {}),
    ...(normalizeText(value.provider, 120) ? { provider: normalizeText(value.provider, 120) } : {}),
    ...(normalizeText(value.service, 120) ? { service: normalizeText(value.service, 120) } : {}),
    ...(Array.isArray(value.options)
      ? {
          options: value.options.filter(isRecord).map((option) => ({
            value: typeof option.value === 'string' ? option.value : '',
            label: typeof option.label === 'string' ? option.label : '',
            ...(typeof option.description === 'string' ? { description: option.description } : {}),
          })).filter((option) => option.value.trim() && option.label.trim()),
        }
      : {}),
    ...(Array.isArray(value.approvalIds)
      ? { approvalIds: value.approvalIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean) }
      : {}),
    ...(Array.isArray(value.approvalSummaries)
      ? {
          approvalSummaries: value.approvalSummaries.filter(isRecord).map((summary) => ({
            id: typeof summary.id === 'string' ? summary.id : '',
            toolName: typeof summary.toolName === 'string' ? summary.toolName : '',
            argsPreview: typeof summary.argsPreview === 'string' ? summary.argsPreview : '',
            ...(typeof summary.actionLabel === 'string' ? { actionLabel: summary.actionLabel } : {}),
            ...(typeof summary.requestId === 'string' ? { requestId: summary.requestId } : {}),
            ...(typeof summary.codeSessionId === 'string' ? { codeSessionId: summary.codeSessionId } : {}),
          })).filter((summary) => summary.id.trim().length > 0),
        }
      : {}),
    ...(normalizeText(value.currentSessionId, 200) ? { currentSessionId: normalizeText(value.currentSessionId, 200) } : {}),
    ...(normalizeText(value.currentSessionLabel, 200) ? { currentSessionLabel: normalizeText(value.currentSessionLabel, 200) } : {}),
    ...(normalizeText(value.targetSessionId, 200) ? { targetSessionId: normalizeText(value.targetSessionId, 200) } : {}),
    ...(normalizeText(value.targetSessionLabel, 200) ? { targetSessionLabel: normalizeText(value.targetSessionLabel, 200) } : {}),
    ...(isRecord(value.metadata) ? { metadata: { ...value.metadata } } : {}),
    ...(typeof value.resolvedAt === 'number' && Number.isFinite(value.resolvedAt) ? { resolvedAt: value.resolvedAt } : {}),
  };
}

function normalizeRecord(value: unknown): ExecutionRecord | null {
  if (!isRecord(value)) return null;
  const executionId = normalizeText(value.executionId, 200);
  const requestId = normalizeText(value.requestId, 200) ?? executionId;
  const scope = normalizeScope(value.scope);
  const intent = normalizeIntent(value.intent);
  if (!executionId || !requestId || !scope || !intent) {
    return null;
  }
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    ? value.createdAt
    : Date.now();
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    ? value.updatedAt
    : createdAt;
  return {
    executionId,
    requestId,
    status: normalizeStatus(value.status),
    scope,
    intent,
    rootExecutionId: normalizeText(value.rootExecutionId, 200) ?? executionId,
    ...(normalizeText(value.parentExecutionId, 200) ? { parentExecutionId: normalizeText(value.parentExecutionId, 200) } : {}),
    ...(normalizeText(value.retryOfExecutionId, 200) ? { retryOfExecutionId: normalizeText(value.retryOfExecutionId, 200) } : {}),
    ...(normalizeBlocker(value.blocker) ? { blocker: normalizeBlocker(value.blocker) as ExecutionBlocker } : {}),
    ...(normalizeText(value.lastUserContent, 4000) ? { lastUserContent: normalizeText(value.lastUserContent, 4000) } : {}),
    createdAt,
    updatedAt,
    ...(typeof value.completedAt === 'number' && Number.isFinite(value.completedAt) ? { completedAt: value.completedAt } : {}),
    ...(typeof value.failedAt === 'number' && Number.isFinite(value.failedAt) ? { failedAt: value.failedAt } : {}),
  };
}

function normalizeStatuses(statuses: readonly ExecutionStatus[] | undefined): Set<ExecutionStatus> | null {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return null;
  }
  return new Set(statuses);
}

function rowFromRecord(record: ExecutionRecord): StoredExecutionRow {
  return {
    execution_id: record.executionId,
    assistant_id: record.scope.assistantId,
    user_id: record.scope.userId,
    channel: record.scope.channel,
    surface_id: record.scope.surfaceId,
    status: record.status,
    root_execution_id: record.rootExecutionId,
    request_id: record.requestId,
    updated_at: record.updatedAt,
    payload_json: JSON.stringify(record),
  };
}

export function resolveExecutionIntentContent(
  record: ExecutionRecord | null | undefined,
): string | null {
  const resolvedContent = record?.intent?.resolvedContent?.trim();
  if (resolvedContent) return resolvedContent;
  const originalUserContent = record?.intent?.originalUserContent?.trim();
  return originalUserContent || null;
}

export class ExecutionStore {
  private readonly now: () => number;
  private readonly mode: 'sqlite' | 'memory';
  private db: SQLiteDatabase | null = null;
  private readonly records = new Map<string, ExecutionRecord>();
  private securityMonitor: SQLiteSecurityMonitor | null = null;
  private insertOrReplaceStmt: SQLiteStatement | null = null;
  private rowByIdStmt: SQLiteStatement | null = null;
  private scopeRowsStmt: SQLiteStatement | null = null;
  private userRowsStmt: SQLiteStatement | null = null;

  constructor(options: ExecutionStoreOptions) {
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
        service: 'executions',
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
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        status TEXT NOT NULL,
        root_execution_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS executions_scope_idx
        ON executions(assistant_id, user_id, channel, surface_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS executions_user_idx
        ON executions(assistant_id, user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS executions_status_idx
        ON executions(status, updated_at DESC);
    `);
    this.insertOrReplaceStmt = this.db.prepare(`
      INSERT OR REPLACE INTO executions (
        execution_id, assistant_id, user_id, channel, surface_id, status,
        root_execution_id, request_id, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.rowByIdStmt = this.db.prepare(`
      SELECT *
      FROM executions
      WHERE execution_id = ?
      LIMIT 1
    `);
    this.scopeRowsStmt = this.db.prepare(`
      SELECT *
      FROM executions
      WHERE assistant_id = ? AND user_id = ? AND channel = ? AND surface_id = ?
      ORDER BY updated_at DESC
    `);
    this.userRowsStmt = this.db.prepare(`
      SELECT *
      FROM executions
      WHERE assistant_id = ? AND user_id = ?
      ORDER BY updated_at DESC
    `);
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.records.clear();
    this.securityMonitor = null;
    this.insertOrReplaceStmt = null;
    this.rowByIdStmt = null;
    this.scopeRowsStmt = null;
    this.userRowsStmt = null;
  }

  private deserializeRow(row: StoredExecutionRow): ExecutionRecord | null {
    try {
      return normalizeRecord(JSON.parse(row.payload_json) as unknown);
    } catch {
      return null;
    }
  }

  private persist(record: ExecutionRecord): ExecutionRecord {
    const normalized = cloneRecord(record);
    if (this.mode === 'sqlite' && this.insertOrReplaceStmt) {
      this.insertOrReplaceStmt.run(
        normalized.executionId,
        normalized.scope.assistantId,
        normalized.scope.userId,
        normalized.scope.channel,
        normalized.scope.surfaceId,
        normalized.status,
        normalized.rootExecutionId,
        normalized.requestId,
        normalized.updatedAt,
        JSON.stringify(normalized),
      );
      this.securityMonitor?.maybeCheck();
      return cloneRecord(normalized);
    }
    this.records.set(normalized.executionId, normalized);
    return cloneRecord(normalized);
  }

  private getStoredRecord(executionId: string): ExecutionRecord | null {
    const normalizedId = executionId.trim();
    if (!normalizedId) return null;
    if (this.mode === 'sqlite' && this.rowByIdStmt) {
      const row = this.rowByIdStmt.get(normalizedId) as StoredExecutionRow | undefined;
      return row ? this.deserializeRow(row) : null;
    }
    return this.records.get(normalizedId) ?? null;
  }

  private mapRowsToRecords(rows: StoredExecutionRow[]): ExecutionRecord[] {
    return rows
      .map((row) => this.deserializeRow(row))
      .filter((record): record is ExecutionRecord => Boolean(record))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(executionId: string): ExecutionRecord | null {
    const record = this.getStoredRecord(executionId);
    return record ? cloneRecord(record) : null;
  }

  listForScope(scope: Pick<ExecutionScope, 'assistantId' | 'userId' | 'channel' | 'surfaceId'>): ExecutionRecord[] {
    const assistantId = scope.assistantId.trim();
    const userId = scope.userId.trim();
    const channel = scope.channel.trim();
    const surfaceId = scope.surfaceId.trim();
    if (!assistantId || !userId || !channel || !surfaceId) {
      return [];
    }
    const rows = this.mode === 'sqlite' && this.scopeRowsStmt
      ? this.scopeRowsStmt.all(assistantId, userId, channel, surfaceId) as StoredExecutionRow[]
      : [...this.records.values()]
        .filter((record) =>
          record.scope.assistantId === assistantId
          && record.scope.userId === userId
          && record.scope.channel === channel
          && record.scope.surfaceId === surfaceId)
        .map(rowFromRecord);
    return this.mapRowsToRecords(rows);
  }

  findLatestForScope(
    scope: Pick<ExecutionScope, 'assistantId' | 'userId' | 'channel' | 'surfaceId'>,
    options?: { statuses?: readonly ExecutionStatus[] },
  ): ExecutionRecord | null {
    const statuses = normalizeStatuses(options?.statuses);
    const record = this.listForScope(scope).find((item) => !statuses || statuses.has(item.status));
    return record ? cloneRecord(record) : null;
  }

  listForAssistantUser(assistantId: string, userId: string): ExecutionRecord[] {
    const normalizedAssistantId = assistantId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedAssistantId || !normalizedUserId) {
      return [];
    }
    const rows = this.mode === 'sqlite' && this.userRowsStmt
      ? this.userRowsStmt.all(normalizedAssistantId, normalizedUserId) as StoredExecutionRow[]
      : [...this.records.values()]
        .filter((record) =>
          record.scope.assistantId === normalizedAssistantId
          && record.scope.userId === normalizedUserId)
        .map(rowFromRecord);
    return this.mapRowsToRecords(rows);
  }

  findLatestForAssistantUser(
    assistantId: string,
    userId: string,
    options?: { statuses?: readonly ExecutionStatus[] },
  ): ExecutionRecord | null {
    const statuses = normalizeStatuses(options?.statuses);
    const record = this.listForAssistantUser(assistantId, userId)
      .find((item) => !statuses || statuses.has(item.status));
    return record ? cloneRecord(record) : null;
  }

  begin(
    input: {
      executionId: string;
      requestId: string;
      parentExecutionId?: string;
      rootExecutionId?: string;
      retryOfExecutionId?: string;
      scope: ExecutionScope;
      originalUserContent: string;
      intent?: Omit<ExecutionIntent, 'originalUserContent'>;
      lastUserContent?: string;
      status?: ExecutionStatus;
    },
    nowMs: number = this.now(),
  ): ExecutionRecord {
    const existing = this.getStoredRecord(input.executionId);
    const next: ExecutionRecord = {
      executionId: input.executionId.trim(),
      requestId: input.requestId.trim() || input.executionId.trim(),
      rootExecutionId: input.rootExecutionId?.trim() || existing?.rootExecutionId || input.executionId.trim(),
      scope: {
        ...input.scope,
        assistantId: input.scope.assistantId.trim(),
        userId: input.scope.userId.trim(),
        channel: input.scope.channel.trim(),
        surfaceId: input.scope.surfaceId.trim(),
      },
      status: input.status ?? existing?.status ?? 'running',
      intent: {
        ...(existing ? cloneIntent(existing.intent) : {}),
        originalUserContent: input.originalUserContent.trim(),
        ...(input.intent ? cloneIntent({
          originalUserContent: input.originalUserContent.trim(),
          ...input.intent,
        }) : {}),
      },
      ...(input.parentExecutionId?.trim() ? { parentExecutionId: input.parentExecutionId.trim() } : existing?.parentExecutionId ? { parentExecutionId: existing.parentExecutionId } : {}),
      ...(input.retryOfExecutionId?.trim() ? { retryOfExecutionId: input.retryOfExecutionId.trim() } : existing?.retryOfExecutionId ? { retryOfExecutionId: existing.retryOfExecutionId } : {}),
      ...(existing?.blocker ? { blocker: cloneBlocker(existing.blocker) } : {}),
      ...(input.lastUserContent?.trim() ? { lastUserContent: input.lastUserContent.trim() } : existing?.lastUserContent ? { lastUserContent: existing.lastUserContent } : {}),
      createdAt: existing?.createdAt ?? nowMs,
      updatedAt: nowMs,
      ...(existing?.completedAt ? { completedAt: existing.completedAt } : {}),
      ...(existing?.failedAt ? { failedAt: existing.failedAt } : {}),
    };
    return this.persist(next);
  }

  update(
    executionId: string,
    patch: Partial<Omit<ExecutionRecord, 'executionId' | 'createdAt'>>,
    nowMs: number = this.now(),
  ): ExecutionRecord | null {
    const existing = this.getStoredRecord(executionId);
    if (!existing) return null;
    const hasPatch = <K extends keyof typeof patch>(key: K): boolean => Object.prototype.hasOwnProperty.call(patch, key);
    const next: ExecutionRecord = {
      ...existing,
      ...(patch.requestId ? { requestId: patch.requestId } : {}),
      ...(hasPatch('parentExecutionId')
        ? (patch.parentExecutionId ? { parentExecutionId: patch.parentExecutionId } : { parentExecutionId: undefined })
        : {}),
      ...(patch.rootExecutionId ? { rootExecutionId: patch.rootExecutionId } : {}),
      ...(hasPatch('retryOfExecutionId')
        ? (patch.retryOfExecutionId ? { retryOfExecutionId: patch.retryOfExecutionId } : { retryOfExecutionId: undefined })
        : {}),
      ...(patch.scope ? { scope: { ...patch.scope } } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.intent ? { intent: cloneIntent(patch.intent) } : {}),
      ...(hasPatch('blocker')
        ? (patch.blocker ? { blocker: cloneBlocker(patch.blocker) } : { blocker: undefined })
        : {}),
      ...(hasPatch('lastUserContent')
        ? (patch.lastUserContent ? { lastUserContent: patch.lastUserContent } : { lastUserContent: undefined })
        : {}),
      ...(hasPatch('completedAt')
        ? (patch.completedAt ? { completedAt: patch.completedAt } : { completedAt: undefined })
        : {}),
      ...(hasPatch('failedAt')
        ? (patch.failedAt ? { failedAt: patch.failedAt } : { failedAt: undefined })
        : {}),
      updatedAt: nowMs,
    };
    return this.persist(next);
  }

  attachBlocker(
    executionId: string,
    blocker: Omit<ExecutionBlocker, 'createdAt' | 'updatedAt' | 'resolvedAt'>,
    nowMs: number = this.now(),
  ): ExecutionRecord | null {
    const existing = this.getStoredRecord(executionId);
    if (!existing) return null;
    const currentCreatedAt = existing.blocker?.createdAt ?? nowMs;
    return this.update(executionId, {
      status: 'blocked',
      blocker: {
        ...cloneBlocker({
          ...blocker,
          createdAt: currentCreatedAt,
          updatedAt: nowMs,
        }),
        createdAt: currentCreatedAt,
        updatedAt: nowMs,
      },
      ...(existing.completedAt ? { completedAt: undefined } : {}),
      ...(existing.failedAt ? { failedAt: undefined } : {}),
    }, nowMs);
  }

  clearBlocker(
    executionId: string,
    options?: {
      status?: ExecutionStatus;
      completedAt?: number | null;
      failedAt?: number | null;
    },
    nowMs: number = this.now(),
  ): ExecutionRecord | null {
    const existing = this.getStoredRecord(executionId);
    if (!existing) return null;
    return this.update(executionId, {
      status: options?.status ?? 'running',
      blocker: undefined,
      ...(options?.completedAt !== undefined
        ? (options.completedAt ? { completedAt: options.completedAt } : { completedAt: undefined })
        : {}),
      ...(options?.failedAt !== undefined
        ? (options.failedAt ? { failedAt: options.failedAt } : { failedAt: undefined })
        : {}),
    }, nowMs);
  }

  complete(executionId: string, nowMs: number = this.now()): ExecutionRecord | null {
    return this.update(executionId, {
      status: 'completed',
      blocker: undefined,
      completedAt: nowMs,
      failedAt: undefined,
    }, nowMs);
  }

  fail(executionId: string, nowMs: number = this.now()): ExecutionRecord | null {
    return this.update(executionId, {
      status: 'failed',
      blocker: undefined,
      failedAt: nowMs,
      completedAt: undefined,
    }, nowMs);
  }

  cancel(executionId: string, nowMs: number = this.now()): ExecutionRecord | null {
    return this.update(executionId, {
      status: 'cancelled',
      blocker: undefined,
      completedAt: undefined,
      failedAt: undefined,
    }, nowMs);
  }
}
