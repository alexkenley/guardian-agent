import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AuditSeverity } from '../guardian/audit-log.js';
import { writeSecureFile } from '../util/secure-fs.js';

import { getGuardianBaseDir } from '../util/env.js';

export type SecurityActivityStatus = 'started' | 'skipped' | 'completed' | 'failed';

export interface SecurityActivityEntry {
  id: string;
  timestamp: number;
  agentId: string;
  targetAgentId?: string;
  status: SecurityActivityStatus;
  severity: AuditSeverity;
  title: string;
  summary: string;
  triggerEventType?: string;
  triggerDetailType?: string;
  triggerSourceAgentId?: string;
  dedupeKey?: string;
  details?: Record<string, unknown>;
}

export interface SecurityActivityListOptions {
  limit?: number;
  status?: SecurityActivityStatus;
  agentId?: string;
}

export interface SecurityActivityListResult {
  entries: SecurityActivityEntry[];
  totalMatches: number;
  returned: number;
  byStatus: Record<SecurityActivityStatus, number>;
}

export interface SecurityActivityLogOptions {
  persistPath?: string;
  maxEntries?: number;
  now?: () => number;
}

interface PersistedSecurityActivityLog {
  entries: SecurityActivityEntry[];
}

const DEFAULT_PERSIST_PATH = resolve(getGuardianBaseDir(), 'security-activity-log.json');
const DEFAULT_MAX_ENTRIES = 1_000;

export function isSecurityActivityStatus(value: string): value is SecurityActivityStatus {
  return value === 'started'
    || value === 'skipped'
    || value === 'completed'
    || value === 'failed';
}

export class SecurityActivityLogService {
  private readonly persistPath: string;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries: SecurityActivityEntry[] = [];
  private readonly listeners = new Set<(entry: SecurityActivityEntry) => void>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options?: SecurityActivityLogOptions) {
    this.persistPath = options?.persistPath ?? DEFAULT_PERSIST_PATH;
    this.maxEntries = Math.max(100, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options?.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedSecurityActivityLog;
      this.entries.length = 0;
      for (const entry of parsed.entries ?? []) {
        const normalized = normalizeSecurityActivityEntry(entry);
        if (normalized) {
          this.entries.push(normalized);
        }
      }
      this.entries.sort((a, b) => b.timestamp - a.timestamp);
      if (this.entries.length > this.maxEntries) {
        this.entries.length = this.maxEntries;
      }
    } catch {
      // First run or unreadable persisted state.
    }
  }

  async persist(): Promise<void> {
    const payload: PersistedSecurityActivityLog = {
      entries: [...this.entries],
    };
    const writeOperation = this.persistQueue
      .catch(() => {})
      .then(() => writeSecureFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf8'));
    this.persistQueue = writeOperation.catch(() => {});
    await writeOperation;
  }

  addListener(listener: (entry: SecurityActivityEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  record(input: Omit<SecurityActivityEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }): SecurityActivityEntry {
    const entry: SecurityActivityEntry = {
      id: input.id?.trim() || randomUUID(),
      timestamp: Number.isFinite(input.timestamp) ? Number(input.timestamp) : this.now(),
      agentId: input.agentId,
      targetAgentId: input.targetAgentId?.trim() || undefined,
      status: input.status,
      severity: input.severity,
      title: input.title.trim(),
      summary: input.summary.trim(),
      triggerEventType: input.triggerEventType?.trim() || undefined,
      triggerDetailType: input.triggerDetailType?.trim() || undefined,
      triggerSourceAgentId: input.triggerSourceAgentId?.trim() || undefined,
      dedupeKey: input.dedupeKey?.trim() || undefined,
      details: input.details && Object.keys(input.details).length > 0 ? { ...input.details } : undefined,
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }

    this.persist().catch(() => {});
    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }

  list(options?: SecurityActivityListOptions): SecurityActivityListResult {
    const limit = Number.isFinite(options?.limit) ? Math.max(1, Math.min(500, Number(options?.limit))) : 200;
    const status = options?.status;
    const agentId = options?.agentId?.trim();
    const matches = this.entries.filter((entry) => {
      if (status && entry.status !== status) return false;
      if (agentId && entry.agentId !== agentId && entry.targetAgentId !== agentId) return false;
      return true;
    });
    const byStatus: Record<SecurityActivityStatus, number> = {
      started: 0,
      skipped: 0,
      completed: 0,
      failed: 0,
    };
    for (const entry of matches) {
      byStatus[entry.status] += 1;
    }
    return {
      entries: matches.slice(0, limit),
      totalMatches: matches.length,
      returned: Math.min(matches.length, limit),
      byStatus,
    };
  }
}

function normalizeSecurityActivityEntry(value: unknown): SecurityActivityEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const status = typeof record.status === 'string' && isSecurityActivityStatus(record.status)
    ? record.status
    : null;
  const severity = typeof record.severity === 'string' && isAuditSeverity(record.severity)
    ? record.severity
    : null;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null;
  const agentId = typeof record.agentId === 'string' && record.agentId.trim() ? record.agentId.trim() : null;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : null;
  const summary = typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : null;
  const timestamp = Number(record.timestamp);
  if (!status || !severity || !id || !agentId || !title || !summary || !Number.isFinite(timestamp)) {
    return null;
  }
  return {
    id,
    timestamp,
    agentId,
    targetAgentId: typeof record.targetAgentId === 'string' && record.targetAgentId.trim() ? record.targetAgentId.trim() : undefined,
    status,
    severity,
    title,
    summary,
    triggerEventType: typeof record.triggerEventType === 'string' && record.triggerEventType.trim() ? record.triggerEventType.trim() : undefined,
    triggerDetailType: typeof record.triggerDetailType === 'string' && record.triggerDetailType.trim() ? record.triggerDetailType.trim() : undefined,
    triggerSourceAgentId: typeof record.triggerSourceAgentId === 'string' && record.triggerSourceAgentId.trim() ? record.triggerSourceAgentId.trim() : undefined,
    dedupeKey: typeof record.dedupeKey === 'string' && record.dedupeKey.trim() ? record.dedupeKey.trim() : undefined,
    details: record.details && typeof record.details === 'object' ? record.details as Record<string, unknown> : undefined,
  };
}

function isAuditSeverity(value: string): value is AuditSeverity {
  return value === 'info' || value === 'warn' || value === 'critical';
}
