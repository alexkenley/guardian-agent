import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import {
  hasSQLiteDriver,
  openSQLiteDatabase,
  type SQLiteDatabase,
  type SQLiteStatement,
} from './sqlite-driver.js';
import { inspectCodeWorkspaceSync, type CodeWorkspaceProfile } from './code-workspace-profile.js';
import {
  cloneWorkspaceMap,
  cloneWorkspaceWorkingSet,
  type CodeWorkspaceMap,
  type CodeWorkspaceWorkingSet,
} from './code-workspace-map.js';
import {
  assessCodeWorkspaceTrustSync,
  cloneCodeWorkspaceTrustReview,
  cloneCodeWorkspaceTrustAssessment,
  createCodeWorkspaceTrustReview,
  reconcileCodeWorkspaceTrustReview,
  type CodeWorkspaceTrustAssessment,
  type CodeWorkspaceTrustReview,
} from './code-workspace-trust.js';
import { SQLiteSecurityMonitor, type SQLiteSecurityEvent } from './sqlite-security.js';
import {
  normalizeReferencedCodeSessionIds,
  normalizeTargetCodeSessionId,
} from './code-session-portfolio.js';

export type CodeSessionStatus =
  | 'idle'
  | 'active'
  | 'awaiting_approval'
  | 'blocked'
  | 'failed'
  | 'completed';

export type CodeSessionAttachmentMode = 'observer' | 'participant' | 'controller';
export type CodeSessionAttachmentPolicy = 'explicit_only' | 'same_principal';

export interface CodeSessionPendingApproval {
  id: string;
  toolName: string;
  argsPreview: string;
  actionLabel?: string;
  createdAt?: number | null;
  risk?: string;
  origin?: string;
  jobId?: string;
  requestId?: string;
}

export interface CodeSessionRecentJob {
  id: string;
  toolName: string;
  status: string;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  resultPreview?: string;
  argsPreview?: string;
  error?: string;
  verificationStatus?: string;
  verificationEvidence?: string;
  approvalId?: string;
  requestId?: string;
}

export interface CodeSessionVerificationEntry {
  id: string;
  kind: 'test' | 'lint' | 'build' | 'manual';
  status: 'pass' | 'warn' | 'fail' | 'not_run';
  summary: string;
  timestamp: number;
  requestId?: string;
  jobId?: string;
}

export interface CodeSessionWorkState {
  focusSummary: string;
  planSummary: string;
  compactedSummary: string;
  compactedSummaryUpdatedAt?: number;
  workspaceProfile: CodeWorkspaceProfile | null;
  workspaceTrust: CodeWorkspaceTrustAssessment | null;
  workspaceTrustReview: CodeWorkspaceTrustReview | null;
  workspaceMap: CodeWorkspaceMap | null;
  workingSet: CodeWorkspaceWorkingSet | null;
  activeSkills: string[];
  pendingApprovals: CodeSessionPendingApproval[];
  recentJobs: CodeSessionRecentJob[];
  changedFiles: string[];
  verification: CodeSessionVerificationEntry[];
}

export interface CodeSessionUiState {
  currentDirectory: string | null;
  selectedFilePath: string | null;
  showDiff: boolean;
  expandedDirs: string[];
  terminalCollapsed: boolean;
  terminalTabs: Array<{
    id: string;
    name: string;
    shell: string;
    output?: string;
  }>;
}

export interface CodeSessionRecord {
  id: string;
  ownerUserId: string;
  ownerPrincipalId?: string;
  title: string;
  workspaceRoot: string;
  resolvedRoot: string;
  agentId: string | null;
  status: CodeSessionStatus;
  attachmentPolicy: CodeSessionAttachmentPolicy;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  conversationUserId: string;
  conversationChannel: string;
  uiState: CodeSessionUiState;
  workState: CodeSessionWorkState;
}

export interface CodeSessionAttachmentRecord {
  id: string;
  codeSessionId: string;
  userId: string;
  principalId?: string;
  channel: string;
  surfaceId: string;
  mode: CodeSessionAttachmentMode;
  attachedAt: number;
  lastSeenAt: number;
  active: boolean;
}

export interface CodeSessionSurfaceStateRecord {
  userId: string;
  principalId?: string;
  channel: string;
  surfaceId: string;
  referencedSessionIds: string[];
  targetSessionId: string | null;
  updatedAt: number;
}

export interface ResolvedCodeSessionContext {
  session: CodeSessionRecord;
  attachment?: CodeSessionAttachmentRecord;
}

export type CodeSessionStoreEvent =
  | { type: 'created'; session: CodeSessionRecord }
  | { type: 'updated'; session: CodeSessionRecord }
  | { type: 'deleted'; sessionId: string; ownerUserId: string }
  | {
      type: 'portfolio_changed';
      userId: string;
      principalId?: string;
      channel: string;
      surfaceId: string;
      referencedSessionIds: string[];
      targetSessionId: string | null;
    }
  | {
      type: 'focus_changed';
      userId: string;
      principalId?: string;
      sessionId: string | null;
      channel: string;
      surfaceId: string;
    };

export type CodeSessionStoreListener = (event: CodeSessionStoreEvent) => void;

export interface CodeSessionStoreOptions {
  enabled?: boolean;
  sqlitePath: string;
  now?: () => number;
  onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
}

export interface CreateCodeSessionInput {
  ownerUserId: string;
  ownerPrincipalId?: string;
  title: string;
  workspaceRoot: string;
  agentId?: string | null;
  attachmentPolicy?: CodeSessionAttachmentPolicy;
}

export interface UpdateCodeSessionInput {
  sessionId: string;
  ownerUserId: string;
  title?: string;
  workspaceRoot?: string;
  agentId?: string | null;
  attachmentPolicy?: CodeSessionAttachmentPolicy;
  status?: CodeSessionStatus;
  uiState?: Partial<CodeSessionUiState>;
  workState?: Partial<CodeSessionWorkState>;
}

interface StoredSessionRow {
  id: string;
  owner_user_id: string;
  owner_principal_id: string | null;
  title: string;
  workspace_root: string;
  resolved_root: string;
  agent_id: string | null;
  status: CodeSessionStatus;
  attachment_policy: CodeSessionAttachmentPolicy;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  conversation_user_id: string;
  conversation_channel: string;
  payload_json: string;
}

interface StoredAttachmentRow {
  id: string;
  code_session_id: string;
  user_id: string;
  principal_id: string | null;
  channel: string;
  surface_id: string;
  mode: CodeSessionAttachmentMode;
  attached_at: number;
  last_seen_at: number;
  active: number;
}

interface StoredSurfaceStateRow {
  user_id: string;
  principal_id: string | null;
  channel: string;
  surface_id: string;
  referenced_session_ids_json: string;
  target_session_id: string | null;
  updated_at: number;
}

interface MemoryStore {
  sessions: Map<string, CodeSessionRecord>;
  attachments: Map<string, CodeSessionAttachmentRecord>;
  surfaceStates: Map<string, CodeSessionSurfaceStateRecord>;
}

function normalizePrincipalId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultUiState(): CodeSessionUiState {
  return {
    currentDirectory: null,
    selectedFilePath: null,
    showDiff: false,
    expandedDirs: [],
    terminalCollapsed: false,
    terminalTabs: [],
  };
}

function defaultWorkState(): CodeSessionWorkState {
  return {
    focusSummary: '',
    planSummary: '',
    compactedSummary: '',
    compactedSummaryUpdatedAt: undefined,
    workspaceProfile: null,
    workspaceTrust: null,
    workspaceTrustReview: null,
    workspaceMap: null,
    workingSet: null,
    activeSkills: [],
    pendingApprovals: [],
    recentJobs: [],
    changedFiles: [],
    verification: [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneWorkspaceProfile(profile: CodeWorkspaceProfile | null | undefined): CodeWorkspaceProfile | null {
  if (!profile) return null;
  return {
    ...profile,
    stack: Array.isArray(profile.stack) ? [...profile.stack] : [],
    manifests: Array.isArray(profile.manifests) ? [...profile.manifests] : [],
    inspectedFiles: Array.isArray(profile.inspectedFiles) ? [...profile.inspectedFiles] : [],
    topLevelEntries: Array.isArray(profile.topLevelEntries) ? [...profile.topLevelEntries] : [],
    entryHints: Array.isArray(profile.entryHints) ? [...profile.entryHints] : [],
  };
}

function cloneWorkspaceTrust(assessment: CodeWorkspaceTrustAssessment | null | undefined): CodeWorkspaceTrustAssessment | null {
  return cloneCodeWorkspaceTrustAssessment(assessment);
}

function cloneWorkspaceTrustReview(review: CodeWorkspaceTrustReview | null | undefined): CodeWorkspaceTrustReview | null {
  return cloneCodeWorkspaceTrustReview(review);
}

function sameWorkspaceTrustReview(
  left: CodeWorkspaceTrustReview | null | undefined,
  right: CodeWorkspaceTrustReview | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.decision === right.decision
    && left.reviewedAt === right.reviewedAt
    && left.reviewedBy === right.reviewedBy
    && left.assessmentFingerprint === right.assessmentFingerprint
    && left.rawState === right.rawState
    && left.findingCount === right.findingCount;
}

function coerceWorkspaceTrustReviewInput(
  value: unknown,
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
  reviewedBy: string,
  now: number,
): CodeWorkspaceTrustReview | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const decisionValue = (value as { decision?: unknown }).decision;
  const decision = typeof decisionValue === 'string'
    ? decisionValue.trim().toLowerCase()
    : '';
  if (decision === 'accepted') {
    const existingReview = cloneWorkspaceTrustReview(value as CodeWorkspaceTrustReview | null | undefined);
    if (
      existingReview
      && existingReview.assessmentFingerprint
      && Number.isFinite(existingReview.reviewedAt)
      && existingReview.reviewedAt > 0
    ) {
      return existingReview;
    }
    return createCodeWorkspaceTrustReview(assessment, reviewedBy, now);
  }
  return null;
}

function normalizePathForHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  if (sep === '/') {
    const driveMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (driveMatch) {
      const drive = driveMatch[1].toLowerCase();
      const rest = driveMatch[2].replace(/\\/g, '/');
      return `/mnt/${drive}/${rest}`;
    }
    return trimmed.replace(/\\/g, '/');
  }

  const mntMatch = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const rest = mntMatch[2].replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }
  return trimmed.replace(/\//g, '\\');
}

function normalizePath(value: string): string {
  const normalized = normalizePathForHost(value.trim() || '.');
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(normalized || '.');
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = sep === '\\' ? candidate.toLowerCase() : candidate;
  const normalizedRoot = sep === '\\' ? root.toLowerCase() : root;
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(
    normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`,
  );
}

function normalizeUiStatePath(value: string | null | undefined, workspaceRoot: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = normalizePathForHost(value);
  const resolvedPath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(workspaceRoot, normalized);
  return isPathInside(resolvedPath, workspaceRoot) ? resolvedPath : null;
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sanitizeUiState(uiState: CodeSessionUiState, workspaceRoot: string): CodeSessionUiState {
  const expandedDirs = Array.from(new Set(
    (Array.isArray(uiState.expandedDirs) ? uiState.expandedDirs : [])
      .map((value) => normalizeUiStatePath(value, workspaceRoot))
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  ));
  return {
    ...uiState,
    currentDirectory: normalizeUiStatePath(uiState.currentDirectory, workspaceRoot),
    selectedFilePath: normalizeUiStatePath(uiState.selectedFilePath, workspaceRoot),
    expandedDirs,
  };
}

function conversationUserIdForSession(sessionId: string, resolvedRoot?: string): string {
  if (!resolvedRoot?.trim()) {
    return `code-session:${sessionId}`;
  }
  const normalized = resolvedRoot.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `code-session:${sessionId}:${normalized}`;
}

function toAttachmentKey(userId: string, channel: string, surfaceId: string): string {
  return `${userId}::${channel}::${surfaceId}`;
}

function toSurfaceStateKey(userId: string, channel: string, surfaceId: string): string {
  return `${userId}::${channel}::${surfaceId}`;
}

export class CodeSessionStore {
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly sqlitePath: string;
  private readonly onSecurityEvent?: (event: SQLiteSecurityEvent) => void;
  private readonly listeners = new Set<CodeSessionStoreListener>();
  private readonly mode: 'sqlite' | 'memory';
  private db: SQLiteDatabase | null = null;
  private securityMonitor: SQLiteSecurityMonitor | null = null;
  private memory: MemoryStore = {
    sessions: new Map(),
    attachments: new Map(),
    surfaceStates: new Map(),
  };
  private insertSessionStmt: SQLiteStatement | null = null;
  private updateSessionStmt: SQLiteStatement | null = null;
  private deleteSessionStmt: SQLiteStatement | null = null;
  private insertAttachmentStmt: SQLiteStatement | null = null;
  private deactivateAttachmentStmt: SQLiteStatement | null = null;
  private updateAttachmentSeenStmt: SQLiteStatement | null = null;
  private upsertSurfaceStateStmt: SQLiteStatement | null = null;
  private deleteSurfaceStateStmt: SQLiteStatement | null = null;

  constructor(options: CodeSessionStoreOptions) {
    this.enabled = options.enabled ?? true;
    this.sqlitePath = options.sqlitePath;
    this.now = options.now ?? Date.now;
    this.onSecurityEvent = options.onSecurityEvent;

    if (!this.enabled || !hasSQLiteDriver()) {
      this.mode = 'memory';
      return;
    }

    try {
      mkdirSync(dirname(this.sqlitePath), { recursive: true });
      this.db = openSQLiteDatabase(this.sqlitePath, { enableForeignKeyConstraints: true });
      if (!this.db) {
        this.mode = 'memory';
        return;
      }
      this.mode = 'sqlite';
      this.initializeSchema();
      this.securityMonitor = new SQLiteSecurityMonitor({
        service: 'code_sessions',
        db: this.db,
        sqlitePath: this.sqlitePath,
        onEvent: this.onSecurityEvent,
        now: this.now,
      });
      this.securityMonitor.initialize();
    } catch {
      this.mode = 'memory';
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.securityMonitor = null;
  }

  subscribe(listener: CodeSessionStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private persistCanonicalRecord(record: CodeSessionRecord): void {
    if (this.mode === 'sqlite' && this.db && this.updateSessionStmt) {
      this.updateSessionStmt.run(...this.toUpdateStoredValues(record));
      this.securityMonitor?.maybeCheck();
      return;
    }

    this.memory.sessions.set(record.id, clone(record));
  }

  private withDerivedWorkspaceProfile(record: CodeSessionRecord): CodeSessionRecord {
    const canonicalResolvedRoot = normalizePath(record.workspaceRoot);
    const canonicalUiState = sanitizeUiState(record.uiState, canonicalResolvedRoot);
    const resolvedRootChanged = canonicalResolvedRoot !== record.resolvedRoot;
    const workspaceMap = cloneWorkspaceMap(record.workState.workspaceMap);
    const workspaceMapChanged = !!workspaceMap && workspaceMap.workspaceRoot !== canonicalResolvedRoot;
    const uiStateChanged = (
      canonicalUiState.currentDirectory !== record.uiState.currentDirectory
      || canonicalUiState.selectedFilePath !== record.uiState.selectedFilePath
      || !sameStringArray(canonicalUiState.expandedDirs, record.uiState.expandedDirs)
    );
    const workspaceProfile = resolvedRootChanged || !record.workState.workspaceProfile
      ? inspectCodeWorkspaceSync(canonicalResolvedRoot, this.now())
      : cloneWorkspaceProfile(record.workState.workspaceProfile);
    const workspaceTrust = resolvedRootChanged || !record.workState.workspaceTrust
      ? assessCodeWorkspaceTrustSync(canonicalResolvedRoot, this.now())
      : cloneWorkspaceTrust(record.workState.workspaceTrust);
    const workspaceTrustReview = reconcileCodeWorkspaceTrustReview(
      workspaceTrust,
      record.workState.workspaceTrustReview,
    );
    const canonicalRecord: CodeSessionRecord = {
      ...record,
      resolvedRoot: canonicalResolvedRoot,
      uiState: canonicalUiState,
      workState: {
        ...record.workState,
        workspaceProfile,
        workspaceTrust,
        workspaceTrustReview,
        workspaceMap: resolvedRootChanged || workspaceMapChanged
          ? null
          : workspaceMap,
        workingSet: resolvedRootChanged || workspaceMapChanged
          ? null
          : cloneWorkspaceWorkingSet(record.workState.workingSet),
      },
    };
    if (
      resolvedRootChanged
      || workspaceMapChanged
      || uiStateChanged
      || !record.workState.workspaceProfile
      || !sameWorkspaceTrustReview(record.workState.workspaceTrustReview, workspaceTrustReview)
    ) {
      this.persistCanonicalRecord(canonicalRecord);
    }
    return canonicalRecord;
  }

  listSessionsForUser(ownerUserId: string): CodeSessionRecord[] {
    if (this.mode === 'sqlite' && this.db) {
      const rows = this.db.prepare(`
        SELECT *
        FROM code_sessions
        WHERE owner_user_id = ?
        ORDER BY last_activity_at DESC, created_at DESC
      `).all(ownerUserId) as unknown as StoredSessionRow[];
      return rows.map((row) => this.withDerivedWorkspaceProfile(this.fromStoredRow(row)));
    }

    return [...this.memory.sessions.values()]
      .filter((session) => session.ownerUserId === ownerUserId)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
      .map((session) => this.withDerivedWorkspaceProfile(clone(session)));
  }

  listAllSessions(): CodeSessionRecord[] {
    if (this.mode === 'sqlite' && this.db) {
      const rows = this.db.prepare(`
        SELECT *
        FROM code_sessions
        ORDER BY last_activity_at DESC, created_at DESC
      `).all() as unknown as StoredSessionRow[];
      return rows.map((row) => this.withDerivedWorkspaceProfile(this.fromStoredRow(row)));
    }

    return [...this.memory.sessions.values()]
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
      .map((session) => this.withDerivedWorkspaceProfile(clone(session)));
  }

  getSession(sessionId: string, ownerUserId?: string): CodeSessionRecord | null {
    if (this.mode === 'sqlite' && this.db) {
      const row = this.db.prepare(`
        SELECT *
        FROM code_sessions
        WHERE id = ?
      `).get(sessionId) as StoredSessionRow | undefined;
      if (!row) return null;
      if (ownerUserId && row.owner_user_id !== ownerUserId) return null;
      return this.withDerivedWorkspaceProfile(this.fromStoredRow(row));
    }

    const session = this.memory.sessions.get(sessionId);
    if (!session) return null;
    if (ownerUserId && session.ownerUserId !== ownerUserId) return null;
    return this.withDerivedWorkspaceProfile(clone(session));
  }

  createSession(input: CreateCodeSessionInput): CodeSessionRecord {
    const now = this.now();
    const id = randomUUID();
    const workspaceRoot = input.workspaceRoot.trim() || '.';
    const resolvedRoot = normalizePath(workspaceRoot);
    const workspaceProfile = inspectCodeWorkspaceSync(resolvedRoot, now);
    const workspaceTrust = assessCodeWorkspaceTrustSync(resolvedRoot, now);
    const record: CodeSessionRecord = {
      id,
      ownerUserId: input.ownerUserId,
      ownerPrincipalId: input.ownerPrincipalId?.trim() || undefined,
      title: input.title.trim() || 'Coding Session',
      workspaceRoot,
      resolvedRoot,
      agentId: input.agentId?.trim() || null,
      status: 'idle',
      attachmentPolicy: input.attachmentPolicy ?? 'same_principal',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      conversationUserId: conversationUserIdForSession(id, resolvedRoot),
      conversationChannel: 'code-session',
      uiState: defaultUiState(),
      workState: {
        ...defaultWorkState(),
        workspaceProfile,
        workspaceTrust,
        workspaceTrustReview: null,
      },
    };

    if (this.mode === 'sqlite' && this.db && this.insertSessionStmt) {
      this.insertSessionStmt.run(...this.toStoredValues(record));
      this.securityMonitor?.maybeCheck();
      const created = clone(record);
      this.emit({ type: 'created', session: created });
      return created;
    }

    this.memory.sessions.set(record.id, clone(record));
    const created = clone(record);
    this.emit({ type: 'created', session: created });
    return created;
  }

  updateSession(input: UpdateCodeSessionInput): CodeSessionRecord | null {
    const existing = this.getSession(input.sessionId, input.ownerUserId);
    if (!existing) return null;

    const now = this.now();
    const nextResolvedRoot = input.workspaceRoot !== undefined ? normalizePath(input.workspaceRoot) : existing.resolvedRoot;
    const workspaceRootChanged = nextResolvedRoot !== existing.resolvedRoot;
    const nextWorkspaceProfile = input.workState?.workspaceProfile !== undefined
      ? cloneWorkspaceProfile(input.workState.workspaceProfile)
      : (input.workspaceRoot !== undefined
        ? inspectCodeWorkspaceSync(nextResolvedRoot, now)
        : cloneWorkspaceProfile(existing.workState.workspaceProfile));
    const nextWorkspaceTrust = input.workState?.workspaceTrust !== undefined
      ? cloneWorkspaceTrust(input.workState.workspaceTrust)
      : (input.workspaceRoot !== undefined
        ? assessCodeWorkspaceTrustSync(nextResolvedRoot, now)
        : cloneWorkspaceTrust(existing.workState.workspaceTrust));
    const hasWorkspaceTrustReviewInput = !!input.workState
      && Object.prototype.hasOwnProperty.call(input.workState, 'workspaceTrustReview');
    const requestedWorkspaceTrustReview = hasWorkspaceTrustReviewInput
      ? coerceWorkspaceTrustReviewInput(
        input.workState?.workspaceTrustReview,
        nextWorkspaceTrust,
        input.ownerUserId,
        now,
      )
      : (workspaceRootChanged ? null : cloneWorkspaceTrustReview(existing.workState.workspaceTrustReview));
    const nextWorkspaceTrustReview = reconcileCodeWorkspaceTrustReview(
      nextWorkspaceTrust,
      requestedWorkspaceTrustReview,
    );
    const nextWorkspaceMap = input.workState?.workspaceMap !== undefined
      ? cloneWorkspaceMap(input.workState.workspaceMap)
      : (workspaceRootChanged ? null : cloneWorkspaceMap(existing.workState.workspaceMap));
    const nextWorkingSet = input.workState?.workingSet !== undefined
      ? cloneWorkspaceWorkingSet(input.workState.workingSet)
      : (workspaceRootChanged ? null : cloneWorkspaceWorkingSet(existing.workState.workingSet));
    const mergedUiState = {
      ...existing.uiState,
      ...(input.uiState ?? {}),
      expandedDirs: Array.isArray(input.uiState?.expandedDirs)
        ? [...input.uiState.expandedDirs]
        : [...existing.uiState.expandedDirs],
      terminalTabs: Array.isArray(input.uiState?.terminalTabs)
        ? input.uiState.terminalTabs.map((tab) => ({ ...tab }))
        : existing.uiState.terminalTabs.map((tab) => ({ ...tab })),
    };
    const next: CodeSessionRecord = {
      ...existing,
      title: input.title !== undefined ? (input.title.trim() || existing.title) : existing.title,
      workspaceRoot: input.workspaceRoot !== undefined ? (input.workspaceRoot.trim() || existing.workspaceRoot) : existing.workspaceRoot,
      agentId: input.agentId !== undefined ? (input.agentId?.trim() || null) : existing.agentId,
      attachmentPolicy: input.attachmentPolicy ?? existing.attachmentPolicy,
      status: input.status ?? existing.status,
      resolvedRoot: nextResolvedRoot,
      updatedAt: now,
      lastActivityAt: now,
      conversationUserId: workspaceRootChanged
        ? conversationUserIdForSession(existing.id, nextResolvedRoot)
        : existing.conversationUserId,
      uiState: sanitizeUiState(mergedUiState, nextResolvedRoot),
      workState: {
        ...(workspaceRootChanged ? defaultWorkState() : existing.workState),
        ...(input.workState ?? {}),
        focusSummary: input.workState?.focusSummary !== undefined
          ? input.workState.focusSummary
          : (workspaceRootChanged ? '' : existing.workState.focusSummary),
        workspaceProfile: nextWorkspaceProfile,
        workspaceTrust: nextWorkspaceTrust,
        workspaceTrustReview: nextWorkspaceTrustReview,
        workspaceMap: nextWorkspaceMap,
        workingSet: nextWorkingSet,
        activeSkills: Array.isArray(input.workState?.activeSkills)
          ? [...input.workState.activeSkills]
          : (workspaceRootChanged ? [] : [...existing.workState.activeSkills]),
        pendingApprovals: Array.isArray(input.workState?.pendingApprovals)
          ? input.workState.pendingApprovals.map((approval) => ({ ...approval }))
          : (workspaceRootChanged ? [] : existing.workState.pendingApprovals.map((approval) => ({ ...approval }))),
        recentJobs: Array.isArray(input.workState?.recentJobs)
          ? input.workState.recentJobs.map((job) => ({ ...job }))
          : (workspaceRootChanged ? [] : existing.workState.recentJobs.map((job) => ({ ...job }))),
        changedFiles: Array.isArray(input.workState?.changedFiles)
          ? [...input.workState.changedFiles]
          : (workspaceRootChanged ? [] : [...existing.workState.changedFiles]),
        verification: Array.isArray(input.workState?.verification)
          ? input.workState.verification.map((entry) => ({ ...entry }))
          : (workspaceRootChanged ? [] : existing.workState.verification.map((entry) => ({ ...entry }))),
      },
    };

    if (this.mode === 'sqlite' && this.db && this.updateSessionStmt) {
      this.updateSessionStmt.run(...this.toUpdateStoredValues(next));
      this.securityMonitor?.maybeCheck();
      const updated = clone(next);
      this.emit({ type: 'updated', session: updated });
      return updated;
    }

    this.memory.sessions.set(next.id, clone(next));
    const updated = clone(next);
    this.emit({ type: 'updated', session: updated });
    return updated;
  }

  deleteSession(sessionId: string, ownerUserId: string): boolean {
    const existing = this.getSession(sessionId, ownerUserId);
    if (!existing) return false;

    if (this.mode === 'sqlite' && this.db && this.deleteSessionStmt) {
      this.deleteSessionStmt.run(sessionId, ownerUserId);
      this.pruneDeletedSessionFromSurfaceStates(ownerUserId, sessionId);
      this.securityMonitor?.maybeCheck();
      this.emit({ type: 'deleted', sessionId, ownerUserId });
      return true;
    }

    this.memory.sessions.delete(sessionId);
    for (const [key, attachment] of this.memory.attachments.entries()) {
      if (attachment.codeSessionId === sessionId) {
        this.memory.attachments.delete(key);
      }
    }
    this.pruneDeletedSessionFromSurfaceStates(ownerUserId, sessionId);
    this.emit({ type: 'deleted', sessionId, ownerUserId });
    return true;
  }

  touchSession(sessionId: string, ownerUserId?: string, status?: CodeSessionStatus): CodeSessionRecord | null {
    const existing = this.getSession(sessionId, ownerUserId);
    if (!existing) return null;
    return this.updateSession({
      sessionId,
      ownerUserId: existing.ownerUserId,
      ...(status ? { status } : {}),
    });
  }

  getSurfaceState(args: {
    userId: string;
    channel: string;
    surfaceId: string;
  }): CodeSessionSurfaceStateRecord | null {
    if (this.mode === 'sqlite' && this.db) {
      const row = this.db.prepare(`
        SELECT *
        FROM code_session_surface_state
        WHERE user_id = ? AND channel = ? AND surface_id = ?
      `).get(args.userId, args.channel, args.surfaceId) as StoredSurfaceStateRow | undefined;
      return row ? this.fromStoredSurfaceStateRow(row) : null;
    }

    const state = this.memory.surfaceStates.get(toSurfaceStateKey(args.userId, args.channel, args.surfaceId));
    return state ? clone(state) : null;
  }

  listReferencedSessionIdsForSurface(args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }): string[] {
    const state = this.getSurfaceState(args);
    const current = this.resolveForRequest({
      userId: args.userId,
      principalId: args.principalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      touchAttachment: false,
    });
    return normalizeReferencedCodeSessionIds({
      referencedSessionIds: state?.referencedSessionIds,
      availableSessions: this.listSessionsForUser(args.userId),
      currentSessionId: current?.session.id ?? null,
    });
  }

  listReferencedSessionsForSurface(args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }): CodeSessionRecord[] {
    return this.listReferencedSessionIdsForSurface(args)
      .map((sessionId) => this.getSession(sessionId, args.userId))
      .filter((session): session is CodeSessionRecord => !!session);
  }

  getTargetSessionIdForSurface(args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }): string | null {
    const state = this.getSurfaceState(args);
    const current = this.resolveForRequest({
      userId: args.userId,
      principalId: args.principalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      touchAttachment: false,
    });
    return normalizeTargetCodeSessionId({
      targetSessionId: state?.targetSessionId,
      availableSessions: this.listSessionsForUser(args.userId),
      currentSessionId: current?.session.id ?? null,
    });
  }

  getTargetSessionForSurface(args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }): CodeSessionRecord | null {
    const targetSessionId = this.getTargetSessionIdForSurface(args);
    return targetSessionId ? this.getSession(targetSessionId, args.userId) : null;
  }

  setReferencedSessionsForSurface(args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    referencedSessionIds: string[];
  }): string[] {
    const now = this.now();
    const normalizedPrincipalId = normalizePrincipalId(args.principalId);
    const current = this.resolveForRequest({
      userId: args.userId,
      principalId: normalizedPrincipalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      touchAttachment: false,
    });
    const normalizedIds = normalizeReferencedCodeSessionIds({
      referencedSessionIds: args.referencedSessionIds,
      availableSessions: this.listSessionsForUser(args.userId),
      currentSessionId: current?.session.id ?? null,
    });
    const existingTargetSessionId = normalizeTargetCodeSessionId({
      targetSessionId: this.getSurfaceState(args)?.targetSessionId,
      availableSessions: this.listSessionsForUser(args.userId),
      currentSessionId: current?.session.id ?? null,
    });
    const normalizedTargetSessionId = existingTargetSessionId && normalizedIds.includes(existingTargetSessionId)
      ? existingTargetSessionId
      : null;

    this.writeSurfaceState({
      userId: args.userId,
      principalId: normalizedPrincipalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      referencedSessionIds: normalizedIds,
      targetSessionId: normalizedTargetSessionId,
      updatedAt: now,
    });

    this.emit({
      type: 'portfolio_changed',
      userId: args.userId,
      principalId: normalizedPrincipalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      referencedSessionIds: [...normalizedIds],
      targetSessionId: normalizedTargetSessionId,
    });
    return normalizedIds;
  }

  setTargetSessionForSurface(args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    targetSessionId?: string | null;
  }): string | null {
    const now = this.now();
    const normalizedPrincipalId = normalizePrincipalId(args.principalId);
    const availableSessions = this.listSessionsForUser(args.userId);
    const current = this.resolveForRequest({
      userId: args.userId,
      principalId: normalizedPrincipalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      touchAttachment: false,
    });
    const state = this.getSurfaceState(args);
    const normalizedTargetSessionId = normalizeTargetCodeSessionId({
      targetSessionId: args.targetSessionId,
      availableSessions,
      currentSessionId: current?.session.id ?? null,
    });
    const normalizedReferencedIds = normalizeReferencedCodeSessionIds({
      referencedSessionIds: state?.referencedSessionIds,
      availableSessions,
      currentSessionId: current?.session.id ?? null,
    });
    if (normalizedTargetSessionId && !normalizedReferencedIds.includes(normalizedTargetSessionId)) {
      normalizedReferencedIds.push(normalizedTargetSessionId);
    }

    this.writeSurfaceState({
      userId: args.userId,
      principalId: normalizedPrincipalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      referencedSessionIds: normalizedReferencedIds,
      targetSessionId: normalizedTargetSessionId,
      updatedAt: now,
    });

    this.emit({
      type: 'portfolio_changed',
      userId: args.userId,
      principalId: normalizedPrincipalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      referencedSessionIds: [...normalizedReferencedIds],
      targetSessionId: normalizedTargetSessionId,
    });
    return normalizedTargetSessionId;
  }

  attachSession(args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    mode?: CodeSessionAttachmentMode;
  }): CodeSessionAttachmentRecord | null {
    let session = this.getSession(args.sessionId, args.userId);
    if (!session) return null;

    if (session.attachmentPolicy !== 'same_principal') {
      const promoted = this.updateSession({
        sessionId: session.id,
        ownerUserId: session.ownerUserId,
        attachmentPolicy: 'same_principal',
      });
      if (promoted) {
        session = promoted;
      }
    }

    const now = this.now();
    const record: CodeSessionAttachmentRecord = {
      id: randomUUID(),
      codeSessionId: session.id,
      userId: args.userId,
      principalId: normalizePrincipalId(args.principalId),
      channel: args.channel,
      surfaceId: args.surfaceId,
      mode: args.mode ?? 'controller',
      attachedAt: now,
      lastSeenAt: now,
      active: true,
    };

    if (session.attachmentPolicy === 'same_principal') {
      this.deactivateActiveAttachmentsForUser(args.userId, record.principalId, now);
    } else {
      this.deactivateSurfaceAttachment(args.userId, args.channel, args.surfaceId, now);
    }

    if (this.mode === 'sqlite' && this.db && this.insertAttachmentStmt) {
      this.insertAttachmentStmt.run(
        record.id,
        record.codeSessionId,
        record.userId,
        record.principalId ?? null,
        record.channel,
        record.surfaceId,
        record.mode,
        record.attachedAt,
        record.lastSeenAt,
        record.active ? 1 : 0,
      );
      this.securityMonitor?.maybeCheck();
    } else {
      this.memory.attachments.set(
        toAttachmentKey(args.userId, args.channel, args.surfaceId),
        clone(record),
      );
    }

    const existingSurfaceState = this.getSurfaceState({
      userId: args.userId,
      channel: args.channel,
      surfaceId: args.surfaceId,
    });
    if (existingSurfaceState) {
      const nextReferencedSessionIds = normalizeReferencedCodeSessionIds({
        referencedSessionIds: existingSurfaceState.referencedSessionIds,
        availableSessions: this.listSessionsForUser(args.userId),
        currentSessionId: session.id,
      });
      const nextTargetSessionId = normalizeTargetCodeSessionId({
        targetSessionId: existingSurfaceState.targetSessionId,
        availableSessions: this.listSessionsForUser(args.userId),
        currentSessionId: session.id,
      });
      this.writeSurfaceState({
        ...existingSurfaceState,
        principalId: record.principalId,
        referencedSessionIds: nextReferencedSessionIds,
        targetSessionId: nextTargetSessionId,
        updatedAt: now,
      });
    }

    this.touchSession(session.id, session.ownerUserId, 'active');
    this.emit({
      type: 'focus_changed',
      userId: args.userId,
      principalId: record.principalId,
      sessionId: session.id,
      channel: args.channel,
      surfaceId: args.surfaceId,
    });
    return clone(record);
  }

  detachSession(args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }): boolean {
    const now = this.now();
    const localAttachment = this.getActiveSurfaceAttachment(args.userId, args.channel, args.surfaceId);
    if (localAttachment) {
      const localSession = this.getSession(localAttachment.codeSessionId, args.userId);
      if (localSession?.attachmentPolicy === 'same_principal') {
        const detached = this.deactivateAttachmentsForSession(
          args.userId,
          normalizePrincipalId(args.principalId),
          localAttachment.codeSessionId,
          now,
        );
        if (detached) {
          this.emit({
            type: 'focus_changed',
            userId: args.userId,
            principalId: normalizePrincipalId(args.principalId),
            sessionId: null,
            channel: args.channel,
            surfaceId: args.surfaceId,
          });
        }
        return detached;
      }
      const detached = this.deactivateSurfaceAttachment(args.userId, args.channel, args.surfaceId, now);
      if (detached) {
        this.emit({
          type: 'focus_changed',
          userId: args.userId,
          principalId: normalizePrincipalId(args.principalId),
          sessionId: this.getSharedAttachment(args.userId, normalizePrincipalId(args.principalId))?.codeSessionId ?? null,
          channel: args.channel,
          surfaceId: args.surfaceId,
        });
      }
      return detached;
    }

    const sharedAttachment = this.getSharedAttachment(args.userId, normalizePrincipalId(args.principalId));
    if (!sharedAttachment) return false;
    const detached = this.deactivateAttachmentsForSession(
      args.userId,
      normalizePrincipalId(args.principalId),
      sharedAttachment.codeSessionId,
      now,
    );
    if (detached) {
      this.emit({
        type: 'focus_changed',
        userId: args.userId,
        principalId: normalizePrincipalId(args.principalId),
        sessionId: null,
        channel: args.channel,
        surfaceId: args.surfaceId,
      });
    }
    return detached;
  }

  resolveForRequest(args: {
    requestedSessionId?: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    touchAttachment?: boolean;
  }): ResolvedCodeSessionContext | null {
    const explicitSessionId = args.requestedSessionId?.trim();
    if (explicitSessionId) {
      const session = this.getSession(explicitSessionId, args.userId);
      if (!session) return null;
      return { session };
    }

    const attachment = this.getActiveSurfaceAttachment(args.userId, args.channel, args.surfaceId)
      ?? this.getSharedAttachment(args.userId, normalizePrincipalId(args.principalId));
    if (!attachment) return null;

    if (args.touchAttachment && attachment.active) {
      this.touchAttachmentSeen(attachment.id, attachment.userId, attachment.channel, attachment.surfaceId);
    }

    const session = this.getSession(attachment.codeSessionId, args.userId);
    if (!session) return null;
    return {
      session,
      attachment,
    };
  }

  private getActiveSurfaceAttachment(userId: string, channel: string, surfaceId: string): CodeSessionAttachmentRecord | null {
    if (this.mode === 'sqlite' && this.db) {
      const row = this.db.prepare(`
        SELECT *
        FROM code_session_attachments
        WHERE user_id = ? AND channel = ? AND surface_id = ? AND active = 1
        ORDER BY last_seen_at DESC, attached_at DESC
        LIMIT 1
      `).get(userId, channel, surfaceId) as StoredAttachmentRow | undefined;
      if (!row) return null;
      return this.fromStoredAttachmentRow(row);
    }

    const attachment = this.memory.attachments.get(toAttachmentKey(userId, channel, surfaceId));
    return attachment ? clone(attachment) : null;
  }

  private getSharedAttachment(userId: string, principalId?: string): CodeSessionAttachmentRecord | null {
    const normalizedPrincipalId = normalizePrincipalId(principalId);

    if (this.mode === 'sqlite' && this.db) {
      const rows = this.db.prepare(`
        SELECT *
        FROM code_session_attachments
        WHERE user_id = ? AND active = 1
        ORDER BY last_seen_at DESC, attached_at DESC
      `).all(userId) as unknown as StoredAttachmentRow[];
      for (const row of rows) {
        const attachment = this.fromStoredAttachmentRow(row);
        if (!this.isPrincipalVisibleToRequest(attachment.principalId, normalizedPrincipalId)) continue;
        const session = this.getSession(attachment.codeSessionId, userId);
        if (!session || session.attachmentPolicy !== 'same_principal') continue;
        return attachment;
      }
      return null;
    }

    const attachment = [...this.memory.attachments.values()]
      .filter((attachment) => attachment.userId === userId && attachment.active)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.attachedAt - left.attachedAt)
      .find((attachment) => {
        if (!this.isPrincipalVisibleToRequest(attachment.principalId, normalizedPrincipalId)) return false;
        const session = this.memory.sessions.get(attachment.codeSessionId);
        return session?.attachmentPolicy === 'same_principal';
      }) ?? null;
    return attachment ? clone(attachment) : null;
  }

  private isPrincipalVisibleToRequest(
    _attachmentPrincipalId: string | undefined,
    _requestedPrincipalId: string | undefined,
  ): boolean {
    return true;
  }

  private deactivateSurfaceAttachment(
    userId: string,
    channel: string,
    surfaceId: string,
    now: number,
  ): boolean {
    if (this.mode === 'sqlite' && this.db && this.deactivateAttachmentStmt) {
      const result = this.deactivateAttachmentStmt.run(now, userId, channel, surfaceId) as { changes?: number } | undefined;
      this.securityMonitor?.maybeCheck();
      return Number(result?.changes ?? 0) > 0;
    }

    return this.memory.attachments.delete(toAttachmentKey(userId, channel, surfaceId));
  }

  private deactivateActiveAttachmentsForUser(
    userId: string,
    principalId: string | undefined,
    now: number,
  ): boolean {
    const normalizedPrincipalId = normalizePrincipalId(principalId);
    if (this.mode === 'sqlite' && this.db) {
      const rows = this.db.prepare(`
        SELECT id, principal_id
        FROM code_session_attachments
        WHERE user_id = ? AND active = 1
      `).all(userId) as Array<{ id: string; principal_id: string | null }>;
      const matchingIds = rows
        .filter((row) => this.isPrincipalVisibleToRequest(row.principal_id ?? undefined, normalizedPrincipalId))
        .map((row) => row.id);
      if (matchingIds.length === 0) return false;
      const stmt = this.db.prepare(`
        UPDATE code_session_attachments
        SET active = 0,
            last_seen_at = ?
        WHERE id = ?
      `);
      for (const id of matchingIds) {
        stmt.run(now, id);
      }
      this.securityMonitor?.maybeCheck();
      return true;
    }

    let changed = false;
    for (const [key, attachment] of this.memory.attachments.entries()) {
      if (attachment.userId !== userId || !attachment.active) continue;
      if (!this.isPrincipalVisibleToRequest(attachment.principalId, normalizedPrincipalId)) continue;
      this.memory.attachments.delete(key);
      changed = true;
    }
    return changed;
  }

  private deactivateAttachmentsForSession(
    userId: string,
    principalId: string | undefined,
    sessionId: string,
    now: number,
  ): boolean {
    const normalizedPrincipalId = normalizePrincipalId(principalId);
    if (this.mode === 'sqlite' && this.db) {
      const rows = this.db.prepare(`
        SELECT id, principal_id
        FROM code_session_attachments
        WHERE user_id = ? AND code_session_id = ? AND active = 1
      `).all(userId, sessionId) as Array<{ id: string; principal_id: string | null }>;
      const matchingIds = rows
        .filter((row) => this.isPrincipalVisibleToRequest(row.principal_id ?? undefined, normalizedPrincipalId))
        .map((row) => row.id);
      if (matchingIds.length === 0) return false;
      const stmt = this.db.prepare(`
        UPDATE code_session_attachments
        SET active = 0,
            last_seen_at = ?
        WHERE id = ?
      `);
      for (const id of matchingIds) {
        stmt.run(now, id);
      }
      this.securityMonitor?.maybeCheck();
      return true;
    }

    let changed = false;
    for (const [key, attachment] of this.memory.attachments.entries()) {
      if (attachment.userId !== userId || attachment.codeSessionId !== sessionId || !attachment.active) continue;
      if (!this.isPrincipalVisibleToRequest(attachment.principalId, normalizedPrincipalId)) continue;
      this.memory.attachments.delete(key);
      changed = true;
    }
    return changed;
  }

  private touchAttachmentSeen(attachmentId: string, userId: string, channel: string, surfaceId: string): void {
    const now = this.now();
    if (this.mode === 'sqlite' && this.db && this.updateAttachmentSeenStmt) {
      this.updateAttachmentSeenStmt.run(now, attachmentId, userId, channel, surfaceId);
      return;
    }

    const key = toAttachmentKey(userId, channel, surfaceId);
    const existing = this.memory.attachments.get(key);
    if (!existing || existing.id !== attachmentId) return;
    existing.lastSeenAt = now;
  }

  private writeSurfaceState(record: CodeSessionSurfaceStateRecord): void {
    if (record.referencedSessionIds.length === 0 && !record.targetSessionId) {
      this.deleteSurfaceState(record.userId, record.channel, record.surfaceId);
      return;
    }
    this.upsertSurfaceState(record);
  }

  private upsertSurfaceState(record: CodeSessionSurfaceStateRecord): void {
    if (this.mode === 'sqlite' && this.db && this.upsertSurfaceStateStmt) {
      this.upsertSurfaceStateStmt.run(
        record.userId,
        record.principalId ?? null,
        record.channel,
        record.surfaceId,
        JSON.stringify(record.referencedSessionIds),
        record.targetSessionId ?? null,
        record.updatedAt,
      );
      this.securityMonitor?.maybeCheck();
      return;
    }

    this.memory.surfaceStates.set(
      toSurfaceStateKey(record.userId, record.channel, record.surfaceId),
      clone(record),
    );
  }

  private deleteSurfaceState(userId: string, channel: string, surfaceId: string): void {
    if (this.mode === 'sqlite' && this.db && this.deleteSurfaceStateStmt) {
      this.deleteSurfaceStateStmt.run(userId, channel, surfaceId);
      this.securityMonitor?.maybeCheck();
      return;
    }

    this.memory.surfaceStates.delete(toSurfaceStateKey(userId, channel, surfaceId));
  }

  private pruneDeletedSessionFromSurfaceStates(userId: string, sessionId: string): void {
    if (this.mode === 'sqlite' && this.db) {
      const rows = this.db.prepare(`
        SELECT *
        FROM code_session_surface_state
        WHERE user_id = ?
      `).all(userId) as unknown as StoredSurfaceStateRow[];
      for (const row of rows) {
        const state = this.fromStoredSurfaceStateRow(row);
        if (!state.referencedSessionIds.includes(sessionId) && state.targetSessionId !== sessionId) continue;
        const nextIds = state.referencedSessionIds.filter((entry) => entry !== sessionId);
        this.writeSurfaceState({
          ...state,
          referencedSessionIds: nextIds,
          targetSessionId: state.targetSessionId === sessionId ? null : state.targetSessionId,
          updatedAt: this.now(),
        });
      }
      return;
    }

    for (const [key, state] of this.memory.surfaceStates.entries()) {
      if (state.userId !== userId || (!state.referencedSessionIds.includes(sessionId) && state.targetSessionId !== sessionId)) continue;
      const nextIds = state.referencedSessionIds.filter((entry) => entry !== sessionId);
      const nextState = {
        ...state,
        referencedSessionIds: nextIds,
        targetSessionId: state.targetSessionId === sessionId ? null : state.targetSessionId,
        updatedAt: this.now(),
      };
      if (nextState.referencedSessionIds.length === 0 && !nextState.targetSessionId) {
        this.memory.surfaceStates.delete(key);
      } else {
        this.memory.surfaceStates.set(key, nextState);
      }
    }
  }

  private fromStoredRow(row: StoredSessionRow): CodeSessionRecord {
    let payload: { uiState?: Partial<CodeSessionUiState>; workState?: Partial<CodeSessionWorkState> } = {};
    try {
      payload = JSON.parse(row.payload_json) as typeof payload;
    } catch {
      payload = {};
    }

    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      ownerPrincipalId: row.owner_principal_id ?? undefined,
      title: row.title,
      workspaceRoot: row.workspace_root,
      resolvedRoot: row.resolved_root,
      agentId: row.agent_id ?? null,
      status: row.status,
      attachmentPolicy: row.attachment_policy,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
      conversationUserId: row.conversation_user_id,
      conversationChannel: row.conversation_channel,
      uiState: {
        ...defaultUiState(),
        ...(payload.uiState ?? {}),
      },
      workState: {
        ...defaultWorkState(),
        ...(payload.workState ?? {}),
        workspaceProfile: cloneWorkspaceProfile(payload.workState?.workspaceProfile as CodeWorkspaceProfile | null | undefined),
        workspaceTrust: cloneWorkspaceTrust(payload.workState?.workspaceTrust as CodeWorkspaceTrustAssessment | null | undefined),
        workspaceTrustReview: cloneWorkspaceTrustReview(payload.workState?.workspaceTrustReview as CodeWorkspaceTrustReview | null | undefined),
        workspaceMap: cloneWorkspaceMap(payload.workState?.workspaceMap as CodeWorkspaceMap | null | undefined),
        workingSet: cloneWorkspaceWorkingSet(payload.workState?.workingSet as CodeWorkspaceWorkingSet | null | undefined),
      },
    };
  }

  private fromStoredAttachmentRow(row: StoredAttachmentRow): CodeSessionAttachmentRecord {
    return {
      id: row.id,
      codeSessionId: row.code_session_id,
      userId: row.user_id,
      principalId: row.principal_id ?? undefined,
      channel: row.channel,
      surfaceId: row.surface_id,
      mode: row.mode,
      attachedAt: row.attached_at,
      lastSeenAt: row.last_seen_at,
      active: row.active === 1,
    };
  }

  private fromStoredSurfaceStateRow(row: StoredSurfaceStateRow): CodeSessionSurfaceStateRecord {
    let referencedSessionIds: string[] = [];
    try {
      referencedSessionIds = JSON.parse(row.referenced_session_ids_json) as string[];
    } catch {
      referencedSessionIds = [];
    }
    return {
      userId: row.user_id,
      principalId: row.principal_id ?? undefined,
      channel: row.channel,
      surfaceId: row.surface_id,
      referencedSessionIds: normalizeReferencedCodeSessionIds({
        referencedSessionIds,
      }),
      targetSessionId: normalizeTargetCodeSessionId({
        targetSessionId: row.target_session_id,
      }),
      updatedAt: row.updated_at,
    };
  }

  private toStoredValues(record: CodeSessionRecord): unknown[] {
    return [
      record.id,
      record.ownerUserId,
      record.ownerPrincipalId ?? null,
      record.title,
      record.workspaceRoot,
      record.resolvedRoot,
      record.agentId,
      record.status,
      record.attachmentPolicy,
      record.createdAt,
      record.updatedAt,
      record.lastActivityAt,
      record.conversationUserId,
      record.conversationChannel,
      JSON.stringify({
        uiState: record.uiState,
        workState: record.workState,
      }),
    ];
  }

  private toUpdateStoredValues(record: CodeSessionRecord): unknown[] {
    return [
      record.ownerUserId,
      record.ownerPrincipalId ?? null,
      record.title,
      record.workspaceRoot,
      record.resolvedRoot,
      record.agentId,
      record.status,
      record.attachmentPolicy,
      record.createdAt,
      record.updatedAt,
      record.lastActivityAt,
      record.conversationUserId,
      record.conversationChannel,
      JSON.stringify({
        uiState: record.uiState,
        workState: record.workState,
      }),
      record.id,
    ];
  }

  private initializeSchema(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_sessions (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        owner_principal_id TEXT,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        resolved_root TEXT NOT NULL,
        agent_id TEXT,
        status TEXT NOT NULL,
        attachment_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        conversation_user_id TEXT NOT NULL,
        conversation_channel TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_code_sessions_owner_activity
        ON code_sessions(owner_user_id, last_activity_at DESC);

      CREATE TABLE IF NOT EXISTS code_session_attachments (
        id TEXT PRIMARY KEY,
        code_session_id TEXT NOT NULL REFERENCES code_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        principal_id TEXT,
        channel TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        attached_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        active INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_code_session_attachments_scope
        ON code_session_attachments(user_id, channel, surface_id, active, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS code_session_surface_state (
        user_id TEXT NOT NULL,
        principal_id TEXT,
        channel TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        referenced_session_ids_json TEXT NOT NULL,
        target_session_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel, surface_id)
      );

      CREATE INDEX IF NOT EXISTS idx_code_session_surface_state_scope
        ON code_session_surface_state(user_id, channel, surface_id);
    `);
    this.ensureSurfaceStateTargetColumn();

    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO code_sessions (
        id,
        owner_user_id,
        owner_principal_id,
        title,
        workspace_root,
        resolved_root,
        agent_id,
        status,
        attachment_policy,
        created_at,
        updated_at,
        last_activity_at,
        conversation_user_id,
        conversation_channel,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateSessionStmt = this.db.prepare(`
      UPDATE code_sessions
      SET owner_user_id = ?,
          owner_principal_id = ?,
          title = ?,
          workspace_root = ?,
          resolved_root = ?,
          agent_id = ?,
          status = ?,
          attachment_policy = ?,
          created_at = ?,
          updated_at = ?,
          last_activity_at = ?,
          conversation_user_id = ?,
          conversation_channel = ?,
          payload_json = ?
      WHERE id = ?
    `);
    this.deleteSessionStmt = this.db.prepare(`
      DELETE FROM code_sessions
      WHERE id = ? AND owner_user_id = ?
    `);
    this.insertAttachmentStmt = this.db.prepare(`
      INSERT INTO code_session_attachments (
        id,
        code_session_id,
        user_id,
        principal_id,
        channel,
        surface_id,
        mode,
        attached_at,
        last_seen_at,
        active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deactivateAttachmentStmt = this.db.prepare(`
      UPDATE code_session_attachments
      SET active = 0,
          last_seen_at = ?
      WHERE user_id = ? AND channel = ? AND surface_id = ? AND active = 1
    `);
    this.updateAttachmentSeenStmt = this.db.prepare(`
      UPDATE code_session_attachments
      SET last_seen_at = ?
      WHERE id = ? AND user_id = ? AND channel = ? AND surface_id = ?
    `);
    this.upsertSurfaceStateStmt = this.db.prepare(`
      INSERT INTO code_session_surface_state (
        user_id,
        principal_id,
        channel,
        surface_id,
        referenced_session_ids_json,
        target_session_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, channel, surface_id)
      DO UPDATE SET
        principal_id = excluded.principal_id,
        referenced_session_ids_json = excluded.referenced_session_ids_json,
        target_session_id = excluded.target_session_id,
        updated_at = excluded.updated_at
    `);
    this.deleteSurfaceStateStmt = this.db.prepare(`
      DELETE FROM code_session_surface_state
      WHERE user_id = ? AND channel = ? AND surface_id = ?
    `);
  }

  private ensureSurfaceStateTargetColumn(): void {
    if (!this.db) return;
    const columns = this.db.prepare(`
      SELECT name
      FROM pragma_table_info('code_session_surface_state')
      WHERE name = 'target_session_id'
    `).all() as Array<{ name?: string }>;
    if (columns.length > 0) {
      return;
    }
    this.db.exec(`
      ALTER TABLE code_session_surface_state
      ADD COLUMN target_session_id TEXT
    `);
  }

  private emit(event: CodeSessionStoreEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
