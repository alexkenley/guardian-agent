import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGuardianBaseDir } from '../util/env.js';
import { mkdirSecureSync, writeSecureFileSync } from '../util/secure-fs.js';

export type CapabilityCandidateKind =
  | 'memory_update'
  | 'skill_create'
  | 'skill_patch'
  | 'workflow'
  | 'tool_adapter';

export type CapabilityCandidateStatus =
  | 'quarantined'
  | 'needs_review'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'archived'
  | 'promoted';

export type CapabilityCandidateRisk = 'low' | 'medium' | 'high' | 'critical';

export interface CapabilityCandidateScopeRef {
  scope: 'global' | 'code_session' | 'system';
  scopeId: string;
  label?: string;
}

export interface CapabilityCandidateEvidence {
  type: 'memory_entry' | 'maintenance_signal' | 'user_signal' | 'runtime_signal' | 'test_result' | 'scan_result';
  title: string;
  detail?: string;
  scope?: 'global' | 'code_session' | 'system';
  scopeId?: string;
  entryId?: string;
  artifactId?: string;
  createdAt?: string;
}

export interface CapabilityCandidateReview {
  decidedAt: string;
  decidedBy: string;
  decision: 'approved' | 'rejected' | 'archived' | 'reopened' | 'promoted';
  reason?: string;
}

export interface CapabilityCandidate {
  id: string;
  kind: CapabilityCandidateKind;
  status: CapabilityCandidateStatus;
  risk: CapabilityCandidateRisk;
  title: string;
  summary: string;
  purpose: string;
  source: 'learning_review' | 'memory_hygiene' | 'operator' | 'coding_session' | 'automation' | 'import';
  sourceRequestId?: string;
  sourceIntentRoute?: string;
  requestedBy?: string;
  scope?: CapabilityCandidateScopeRef;
  evidence: CapabilityCandidateEvidence[];
  proposedChange?: string;
  reviewNotes?: string;
  tags: string[];
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  review?: CapabilityCandidateReview;
}

export interface CapabilityCandidateInput {
  kind: CapabilityCandidateKind;
  risk?: CapabilityCandidateRisk;
  title: string;
  summary: string;
  purpose: string;
  source: CapabilityCandidate['source'];
  sourceRequestId?: string;
  sourceIntentRoute?: string;
  requestedBy?: string;
  scope?: CapabilityCandidateScopeRef;
  evidence?: CapabilityCandidateEvidence[];
  proposedChange?: string;
  reviewNotes?: string;
  tags?: string[];
  dedupeKey: string;
  expiresAt?: string;
}

export interface CapabilityCandidateListInput {
  status?: CapabilityCandidateStatus | 'active' | 'inactive' | 'all';
  kind?: CapabilityCandidateKind;
  limit?: number;
}

export interface CapabilityCandidateSummary {
  total: number;
  active: number;
  quarantined: number;
  needsReview: number;
  approved: number;
  rejected: number;
  expired: number;
  archived: number;
  promoted: number;
  byKind: Record<CapabilityCandidateKind, number>;
}

export interface CapabilityCandidateActionInput {
  candidateId: string;
  action: 'approve' | 'reject' | 'archive' | 'reopen' | 'promote';
  actor?: string;
  reason?: string;
}

export interface CapabilityCandidateActionResult {
  candidate: CapabilityCandidate;
  changed: boolean;
}

export interface CapabilityCandidateExpireResult {
  reviewedCandidates: number;
  expiredCandidates: number;
}

export interface CapabilityCandidateStoreOptions {
  basePath?: string;
  now?: () => number;
}

interface CapabilityCandidateIndexFile {
  version: 1;
  candidates: CapabilityCandidate[];
}

const EMPTY_INDEX: CapabilityCandidateIndexFile = { version: 1, candidates: [] };
const ACTIVE_STATUSES = new Set<CapabilityCandidateStatus>(['quarantined', 'needs_review', 'approved']);
const ALL_KINDS: CapabilityCandidateKind[] = ['memory_update', 'skill_create', 'skill_patch', 'workflow', 'tool_adapter'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeTags(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(500, Math.round(limit ?? fallback)));
}

function addDaysIso(fromMs: number, days: number): string {
  return new Date(fromMs + Math.max(1, Math.round(days)) * 24 * 60 * 60 * 1000).toISOString();
}

function cloneCandidate(candidate: CapabilityCandidate): CapabilityCandidate {
  return {
    ...candidate,
    scope: candidate.scope ? { ...candidate.scope } : undefined,
    evidence: candidate.evidence.map((entry) => ({ ...entry })),
    tags: [...candidate.tags],
    review: candidate.review ? { ...candidate.review } : undefined,
  };
}

function readReview(value: unknown): CapabilityCandidateReview | undefined {
  if (!isRecord(value)) return undefined;
  const decidedAt = normalizeText(typeof value.decidedAt === 'string' ? value.decidedAt : '');
  const decidedBy = normalizeText(typeof value.decidedBy === 'string' ? value.decidedBy : '');
  const decision = (
    value.decision === 'approved'
    || value.decision === 'rejected'
    || value.decision === 'archived'
    || value.decision === 'reopened'
    || value.decision === 'promoted'
  ) ? value.decision : null;
  if (!decidedAt || !decidedBy || !decision) return undefined;
  return {
    decidedAt,
    decidedBy,
    decision,
    ...(typeof value.reason === 'string' && value.reason.trim() ? { reason: value.reason.trim() } : {}),
  };
}

function readCandidate(value: unknown): CapabilityCandidate | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const kind = ALL_KINDS.includes(value.kind as CapabilityCandidateKind)
    ? value.kind as CapabilityCandidateKind
    : null;
  const status = (
    value.status === 'quarantined'
    || value.status === 'needs_review'
    || value.status === 'approved'
    || value.status === 'rejected'
    || value.status === 'expired'
    || value.status === 'archived'
    || value.status === 'promoted'
  ) ? value.status as CapabilityCandidateStatus : null;
  const risk = (
    value.risk === 'medium'
    || value.risk === 'high'
    || value.risk === 'critical'
  ) ? value.risk as CapabilityCandidateRisk : 'low';
  const title = normalizeText(typeof value.title === 'string' ? value.title : '');
  const summary = normalizeText(typeof value.summary === 'string' ? value.summary : '');
  const purpose = normalizeText(typeof value.purpose === 'string' ? value.purpose : '');
  const source = (
    value.source === 'memory_hygiene'
    || value.source === 'operator'
    || value.source === 'coding_session'
    || value.source === 'automation'
    || value.source === 'import'
  ) ? value.source as CapabilityCandidate['source'] : 'learning_review';
  const dedupeKey = normalizeText(typeof value.dedupeKey === 'string' ? value.dedupeKey : '');
  const createdAt = normalizeText(typeof value.createdAt === 'string' ? value.createdAt : '');
  const updatedAt = normalizeText(typeof value.updatedAt === 'string' ? value.updatedAt : createdAt);
  if (!id || !kind || !status || !title || !summary || !purpose || !dedupeKey || !createdAt) {
    return null;
  }

  const scopeValue = isRecord(value.scope) ? value.scope : null;
  const scopeKind = scopeValue?.scope;
  const scope: CapabilityCandidateScopeRef | undefined = scopeValue
    && (scopeKind === 'global' || scopeKind === 'code_session' || scopeKind === 'system')
    && typeof scopeValue.scopeId === 'string'
    ? {
        scope: scopeKind,
        scopeId: scopeValue.scopeId,
        ...(typeof scopeValue.label === 'string' && scopeValue.label.trim() ? { label: scopeValue.label.trim() } : {}),
      }
    : undefined;
  const review = readReview(value.review);

  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .filter(isRecord)
        .map((entry): CapabilityCandidateEvidence | null => {
          const type = (
            entry.type === 'memory_entry'
            || entry.type === 'maintenance_signal'
            || entry.type === 'user_signal'
            || entry.type === 'runtime_signal'
            || entry.type === 'test_result'
            || entry.type === 'scan_result'
          ) ? entry.type : null;
          const evidenceTitle = normalizeText(typeof entry.title === 'string' ? entry.title : '');
          if (!type || !evidenceTitle) return null;
          return {
            type,
            title: evidenceTitle,
            ...(typeof entry.detail === 'string' && entry.detail.trim() ? { detail: entry.detail.trim() } : {}),
            ...((entry.scope === 'global' || entry.scope === 'code_session' || entry.scope === 'system') ? { scope: entry.scope } : {}),
            ...(typeof entry.scopeId === 'string' && entry.scopeId.trim() ? { scopeId: entry.scopeId.trim() } : {}),
            ...(typeof entry.entryId === 'string' && entry.entryId.trim() ? { entryId: entry.entryId.trim() } : {}),
            ...(typeof entry.artifactId === 'string' && entry.artifactId.trim() ? { artifactId: entry.artifactId.trim() } : {}),
            ...(typeof entry.createdAt === 'string' && entry.createdAt.trim() ? { createdAt: entry.createdAt.trim() } : {}),
          };
        })
        .filter((entry): entry is CapabilityCandidateEvidence => Boolean(entry))
    : [];

  return {
    id,
    kind,
    status,
    risk,
    title,
    summary,
    purpose,
    source,
    ...(typeof value.sourceRequestId === 'string' && value.sourceRequestId.trim() ? { sourceRequestId: value.sourceRequestId.trim() } : {}),
    ...(typeof value.sourceIntentRoute === 'string' && value.sourceIntentRoute.trim() ? { sourceIntentRoute: value.sourceIntentRoute.trim() } : {}),
    ...(typeof value.requestedBy === 'string' && value.requestedBy.trim() ? { requestedBy: value.requestedBy.trim() } : {}),
    ...(scope ? { scope } : {}),
    evidence,
    ...(typeof value.proposedChange === 'string' && value.proposedChange.trim() ? { proposedChange: value.proposedChange.trim() } : {}),
    ...(typeof value.reviewNotes === 'string' && value.reviewNotes.trim() ? { reviewNotes: value.reviewNotes.trim() } : {}),
    tags: normalizeTags(Array.isArray(value.tags) ? value.tags.filter((entry): entry is string => typeof entry === 'string') : []),
    dedupeKey,
    createdAt,
    updatedAt,
    ...(typeof value.expiresAt === 'string' && value.expiresAt.trim() ? { expiresAt: value.expiresAt.trim() } : {}),
    ...(review ? { review } : {}),
  };
}

export class CapabilityCandidateStore {
  private readonly basePath: string;
  private readonly now: () => number;
  private indexCache: CapabilityCandidateIndexFile | null = null;

  constructor(options: CapabilityCandidateStoreOptions = {}) {
    this.basePath = options.basePath ?? join(getGuardianBaseDir(), 'capability-candidates');
    this.now = options.now ?? Date.now;
    mkdirSecureSync(this.basePath);
  }

  list(input: CapabilityCandidateListInput = {}): CapabilityCandidate[] {
    const limit = clampLimit(input.limit, 100);
    return this.readIndex().candidates
      .filter((candidate) => {
        if (input.kind && candidate.kind !== input.kind) return false;
        if (!input.status || input.status === 'all') return true;
        if (input.status === 'active') return ACTIVE_STATUSES.has(candidate.status);
        if (input.status === 'inactive') return !ACTIVE_STATUSES.has(candidate.status);
        return candidate.status === input.status;
      })
      .slice()
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit)
      .map(cloneCandidate);
  }

  summary(): CapabilityCandidateSummary {
    const summary: CapabilityCandidateSummary = {
      total: 0,
      active: 0,
      quarantined: 0,
      needsReview: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
      archived: 0,
      promoted: 0,
      byKind: {
        memory_update: 0,
        skill_create: 0,
        skill_patch: 0,
        workflow: 0,
        tool_adapter: 0,
      },
    };

    for (const candidate of this.readIndex().candidates) {
      summary.total += 1;
      summary.byKind[candidate.kind] += 1;
      if (ACTIVE_STATUSES.has(candidate.status)) summary.active += 1;
      if (candidate.status === 'quarantined') summary.quarantined += 1;
      else if (candidate.status === 'needs_review') summary.needsReview += 1;
      else if (candidate.status === 'approved') summary.approved += 1;
      else if (candidate.status === 'rejected') summary.rejected += 1;
      else if (candidate.status === 'expired') summary.expired += 1;
      else if (candidate.status === 'archived') summary.archived += 1;
      else if (candidate.status === 'promoted') summary.promoted += 1;
    }

    return summary;
  }

  upsert(input: CapabilityCandidateInput): CapabilityCandidateActionResult {
    const nowIso = new Date(this.now()).toISOString();
    const index = this.readIndex();
    const dedupeKey = normalizeText(input.dedupeKey);
    if (!dedupeKey) {
      throw new Error('Capability candidate dedupeKey is required');
    }
    const existing = index.candidates.find((candidate) => (
      candidate.dedupeKey === dedupeKey && ACTIVE_STATUSES.has(candidate.status)
    ));
    if (existing) {
      existing.updatedAt = nowIso;
      if (input.expiresAt) existing.expiresAt = input.expiresAt;
      existing.evidence = mergeEvidence(existing.evidence, input.evidence ?? []);
      existing.tags = normalizeTags([...existing.tags, ...(input.tags ?? [])]);
      this.writeIndex(index);
      return { candidate: cloneCandidate(existing), changed: false };
    }

    const candidate: CapabilityCandidate = {
      id: `capcand-${randomUUID()}`,
      kind: input.kind,
      status: 'quarantined',
      risk: input.risk ?? 'low',
      title: normalizeText(input.title),
      summary: normalizeText(input.summary),
      purpose: normalizeText(input.purpose),
      source: input.source,
      ...(input.sourceRequestId ? { sourceRequestId: normalizeText(input.sourceRequestId) } : {}),
      ...(input.sourceIntentRoute ? { sourceIntentRoute: normalizeText(input.sourceIntentRoute) } : {}),
      ...(input.requestedBy ? { requestedBy: normalizeText(input.requestedBy) } : {}),
      ...(input.scope ? { scope: { ...input.scope } } : {}),
      evidence: (input.evidence ?? []).map((entry) => ({ ...entry })),
      ...(input.proposedChange ? { proposedChange: normalizeText(input.proposedChange) } : {}),
      ...(input.reviewNotes ? { reviewNotes: normalizeText(input.reviewNotes) } : {}),
      tags: normalizeTags(input.tags),
      dedupeKey,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };

    if (!candidate.title || !candidate.summary || !candidate.purpose) {
      throw new Error('Capability candidate title, summary, and purpose are required');
    }

    index.candidates.unshift(candidate);
    this.writeIndex(index);
    return { candidate: cloneCandidate(candidate), changed: true };
  }

  applyAction(input: CapabilityCandidateActionInput): CapabilityCandidateActionResult {
    const index = this.readIndex();
    const candidate = index.candidates.find((entry) => entry.id === input.candidateId);
    if (!candidate) {
      throw new Error(`Capability candidate '${input.candidateId}' was not found`);
    }
    const status = statusForAction(input.action);
    if (candidate.status === status) {
      return { candidate: cloneCandidate(candidate), changed: false };
    }
    const nowIso = new Date(this.now()).toISOString();
    candidate.status = status;
    candidate.updatedAt = nowIso;
    candidate.review = {
      decidedAt: nowIso,
      decidedBy: normalizeText(input.actor) || 'web-user',
      decision: input.action === 'reject' ? 'rejected' : input.action === 'approve' ? 'approved' : input.action === 'archive' ? 'archived' : input.action === 'promote' ? 'promoted' : 'reopened',
      ...(normalizeText(input.reason) ? { reason: normalizeText(input.reason) } : {}),
    };
    if (input.action === 'reopen') {
      candidate.status = 'quarantined';
    }
    this.writeIndex(index);
    return { candidate: cloneCandidate(candidate), changed: true };
  }

  expireStale(expireAfterDays: number, maxCandidates = 50): CapabilityCandidateExpireResult {
    const index = this.readIndex();
    const nowMs = this.now();
    const limit = clampLimit(maxCandidates, 50);
    let reviewedCandidates = 0;
    let expiredCandidates = 0;
    for (const candidate of index.candidates) {
      if (reviewedCandidates >= limit) break;
      if (!ACTIVE_STATUSES.has(candidate.status)) continue;
      reviewedCandidates += 1;
      const explicitExpiry = Date.parse(candidate.expiresAt ?? '');
      const fallbackExpiry = Date.parse(candidate.updatedAt) + Math.max(1, expireAfterDays) * 24 * 60 * 60 * 1000;
      const expiresAt = Number.isFinite(explicitExpiry) ? explicitExpiry : fallbackExpiry;
      if (expiresAt > nowMs) continue;
      candidate.status = 'expired';
      candidate.updatedAt = new Date(nowMs).toISOString();
      expiredCandidates += 1;
    }
    if (expiredCandidates > 0) {
      this.writeIndex(index);
    }
    return { reviewedCandidates, expiredCandidates };
  }

  buildExpiry(days: number): string {
    return addDaysIso(this.now(), days);
  }

  private readIndex(): CapabilityCandidateIndexFile {
    if (this.indexCache) return this.indexCache;
    const path = this.indexPath();
    if (!existsSync(path)) {
      this.indexCache = { ...EMPTY_INDEX, candidates: [] };
      return this.indexCache;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      const rawCandidates = isRecord(parsed) && Array.isArray(parsed.candidates) ? parsed.candidates : [];
      this.indexCache = {
        version: 1,
        candidates: rawCandidates
          .map(readCandidate)
          .filter((candidate): candidate is CapabilityCandidate => Boolean(candidate)),
      };
      return this.indexCache;
    } catch {
      this.indexCache = { ...EMPTY_INDEX, candidates: [] };
      return this.indexCache;
    }
  }

  private writeIndex(index: CapabilityCandidateIndexFile): void {
    this.indexCache = {
      version: 1,
      candidates: index.candidates.map(cloneCandidate),
    };
    writeSecureFileSync(this.indexPath(), `${JSON.stringify(this.indexCache, null, 2)}\n`);
  }

  private indexPath(): string {
    return join(this.basePath, 'index.json');
  }
}

function mergeEvidence(
  existing: CapabilityCandidateEvidence[],
  incoming: CapabilityCandidateEvidence[],
): CapabilityCandidateEvidence[] {
  const merged: CapabilityCandidateEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of [...existing, ...incoming]) {
    const key = [
      entry.type,
      entry.scope ?? '',
      entry.scopeId ?? '',
      entry.entryId ?? '',
      entry.artifactId ?? '',
      entry.title,
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...entry });
  }
  return merged.slice(0, 20);
}

function statusForAction(action: CapabilityCandidateActionInput['action']): CapabilityCandidateStatus {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'archive':
      return 'archived';
    case 'promote':
      return 'promoted';
    case 'reopen':
      return 'quarantined';
  }
}
