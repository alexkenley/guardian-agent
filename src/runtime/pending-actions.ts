import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatPendingApprovalMessage } from './pending-approval-copy.js';
import { normalizeIntentGatewayDecisionProvenance } from './intent/provenance.js';
import { normalizeUserFacingIntentGatewaySummary } from './intent/summary.js';
import type { IntentGatewayDecisionProvenance } from './intent/types.js';
import type { ExecutionArtifactRef, ExecutionNodeKind } from './execution-graph/types.js';
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
  | 'playbook_run'
  | 'execution_graph'
  | 'worker_approval';

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
  actionLabel?: string;
  requestId?: string;
  codeSessionId?: string;
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
  provenance?: IntentGatewayDecisionProvenance;
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

export interface PendingActionGraphInterrupt {
  graphId: string;
  nodeId: string;
  nodeKind?: ExecutionNodeKind;
  resumeToken: string;
  artifactRefs: ExecutionArtifactRef[];
}

export interface PendingActionRecord {
  id: string;
  scope: PendingActionScope;
  status: PendingActionStatus;
  transferPolicy: PendingActionTransferPolicy;
  blocker: PendingActionBlocker;
  intent: PendingActionIntent;
  resume?: PendingActionResume;
  graphInterrupt?: PendingActionGraphInterrupt;
  executionId?: string;
  rootExecutionId?: string;
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
    ...(record.graphInterrupt ? { graphInterrupt: cloneGraphInterrupt(record.graphInterrupt) } : {}),
    ...(record.executionId ? { executionId: record.executionId } : {}),
    ...(record.rootExecutionId ? { rootExecutionId: record.rootExecutionId } : {}),
  };
}

function cloneGraphInterrupt(interrupt: PendingActionGraphInterrupt): PendingActionGraphInterrupt {
  return {
    graphId: interrupt.graphId,
    nodeId: interrupt.nodeId,
    ...(interrupt.nodeKind ? { nodeKind: interrupt.nodeKind } : {}),
    resumeToken: interrupt.resumeToken,
    artifactRefs: interrupt.artifactRefs.map((artifact) => ({
      ...artifact,
      ...(artifact.taintReasons ? { taintReasons: [...artifact.taintReasons] } : {}),
    })),
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
    ...(provenance ? { provenance: { ...provenance, ...(provenance.entities ? { entities: { ...provenance.entities } } : {}) } } : {}),
    ...(entities ? { entities: { ...entities } } : {}),
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
    case 'execution_graph':
    case 'worker_approval':
      return value;
    default:
      return undefined;
  }
}

function normalizeExecutionNodeKind(value: unknown): ExecutionNodeKind | undefined {
  switch (value) {
    case 'classify':
    case 'plan':
    case 'explore_readonly':
    case 'synthesize':
    case 'mutate':
    case 'approval_interrupt':
    case 'delegated_worker':
    case 'verify':
    case 'recover':
    case 'finalize':
      return value;
    default:
      return undefined;
  }
}

function normalizeExecutionArtifactRef(value: unknown): ExecutionArtifactRef | null {
  if (!isRecord(value)) return null;
  const artifactId = typeof value.artifactId === 'string' ? value.artifactId.trim() : '';
  const graphId = typeof value.graphId === 'string' ? value.graphId.trim() : '';
  const nodeId = typeof value.nodeId === 'string' ? value.nodeId.trim() : '';
  const artifactType = typeof value.artifactType === 'string' ? value.artifactType.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0;
  if (!artifactId || !graphId || !nodeId || !artifactType || !label || createdAt <= 0) return null;
  return {
    artifactId,
    graphId,
    nodeId,
    artifactType: artifactType as ExecutionArtifactRef['artifactType'],
    label,
    ...(typeof value.preview === 'string' && value.preview.trim() ? { preview: value.preview.trim() } : {}),
    ...(value.trustLevel === 'trusted' || value.trustLevel === 'low_trust' || value.trustLevel === 'quarantined'
      ? { trustLevel: value.trustLevel }
      : {}),
    ...(Array.isArray(value.taintReasons)
      ? {
          taintReasons: value.taintReasons
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        }
      : {}),
    ...(typeof value.redactionPolicy === 'string' && value.redactionPolicy.trim()
      ? { redactionPolicy: value.redactionPolicy.trim() }
      : {}),
    createdAt,
  };
}

function normalizeGraphInterrupt(value: unknown): PendingActionGraphInterrupt | undefined {
  if (!isRecord(value)) return undefined;
  const graphId = typeof value.graphId === 'string' ? value.graphId.trim() : '';
  const nodeId = typeof value.nodeId === 'string' ? value.nodeId.trim() : '';
  const resumeToken = typeof value.resumeToken === 'string' ? value.resumeToken.trim() : '';
  if (!graphId || !nodeId || !resumeToken) return undefined;
  const artifactRefs = Array.isArray(value.artifactRefs)
    ? value.artifactRefs
      .map(normalizeExecutionArtifactRef)
      .filter((item): item is ExecutionArtifactRef => !!item)
    : [];
  return {
    graphId,
    nodeId,
    ...(normalizeExecutionNodeKind(value.nodeKind) ? { nodeKind: normalizeExecutionNodeKind(value.nodeKind) } : {}),
    resumeToken,
    artifactRefs,
  };
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

export function fallbackPendingActionPrompt(
  blockerKind: PendingActionBlockerKind,
): string {
  switch (blockerKind) {
    case 'approval':
      return 'Approval required for the pending action.';
    case 'clarification':
      return 'I need a bit more detail before I can continue with that request.';
    case 'workspace_switch':
      return 'Switch workspaces first, then continue the request.';
    case 'auth':
      return 'Authentication is required before I can continue.';
    case 'policy':
      return 'This request is blocked by policy and needs approval.';
    case 'missing_context':
      return 'I need the required context before I can continue.';
    default:
      return 'This request is waiting for input.';
  }
}

export function sanitizePendingActionPrompt(
  prompt: string | null | undefined,
  blockerKind: PendingActionBlockerKind,
): string {
  return normalizeUserFacingIntentGatewaySummary(prompt)
    ?? fallbackPendingActionPrompt(blockerKind);
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
        ...(typeof item.actionLabel === 'string' && item.actionLabel.trim()
          ? { actionLabel: item.actionLabel.trim() }
          : {}),
        ...(typeof item.requestId === 'string' && item.requestId.trim()
          ? { requestId: item.requestId.trim() }
          : {}),
        ...(typeof item.codeSessionId === 'string' && item.codeSessionId.trim()
          ? { codeSessionId: item.codeSessionId.trim() }
          : {}),
      }))
      .filter((item) => item.id && item.toolName)
    : undefined;

  const blockerKind = normalizeBlockerKind(value.blocker.kind);
  const summary = normalizeUserFacingIntentGatewaySummary(
    typeof value.intent.summary === 'string' ? value.intent.summary : undefined,
  );

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
      ...(summary ? { summary } : {}),
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
      ...(normalizeIntentGatewayDecisionProvenance(value.intent.provenance)
        ? { provenance: normalizeIntentGatewayDecisionProvenance(value.intent.provenance) }
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
    ...(normalizeGraphInterrupt(value.graphInterrupt) ? { graphInterrupt: normalizeGraphInterrupt(value.graphInterrupt) } : {}),
    ...(typeof value.executionId === 'string' && value.executionId.trim() ? { executionId: value.executionId.trim() } : {}),
    ...(typeof value.rootExecutionId === 'string' && value.rootExecutionId.trim() ? { rootExecutionId: value.rootExecutionId.trim() } : {}),
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
  summary?: string;
  resolution?: string;
  missingFields?: string[];
  provenance?: IntentGatewayDecisionProvenance;
  entities?: Record<string, unknown>;
  options?: PendingActionOption[];
  field?: string;
  executionId?: string;
  rootExecutionId?: string;
  graphInterrupt?: PendingActionGraphInterrupt;
} | null {
  if (!record || !isPendingActionActive(record.status)) return null;
  const prompt = sanitizePendingActionPrompt(record.blocker.prompt, record.blocker.kind);
  const summary = normalizeUserFacingIntentGatewaySummary(record.intent.summary);
  return {
    id: record.id,
    status: record.status,
    blockerKind: record.blocker.kind,
    transferPolicy: record.transferPolicy,
    prompt,
    originalRequest: record.intent.originalUserContent,
    ...(record.intent.route ? { route: record.intent.route } : {}),
    ...(record.intent.operation ? { operation: record.intent.operation } : {}),
    ...(summary ? { summary } : {}),
    ...(record.intent.resolution ? { resolution: record.intent.resolution } : {}),
    ...(record.intent.missingFields?.length ? { missingFields: [...record.intent.missingFields] } : {}),
    ...(record.intent.provenance ? { provenance: cloneIntent(record.intent).provenance } : {}),
    ...(record.intent.entities ? { entities: { ...record.intent.entities } } : {}),
    ...(record.blocker.options?.length ? { options: record.blocker.options.map((option) => ({ ...option })) } : {}),
    ...(record.blocker.field ? { field: record.blocker.field } : {}),
    ...(record.executionId ? { executionId: record.executionId } : {}),
    ...(record.rootExecutionId ? { rootExecutionId: record.rootExecutionId } : {}),
    ...(record.graphInterrupt ? { graphInterrupt: cloneGraphInterrupt(record.graphInterrupt) } : {}),
  };
}

export function toPendingActionClientMetadata(
  record: PendingActionRecord | null | undefined,
): Record<string, unknown> | undefined {
  if (!record || !isPendingActionActive(record.status)) return undefined;
  const prompt = sanitizePendingActionPrompt(record.blocker.prompt, record.blocker.kind);
  const summary = normalizeUserFacingIntentGatewaySummary(record.intent.summary);
  return {
    id: record.id,
    status: record.status,
    expiresAt: record.expiresAt,
    transferPolicy: record.transferPolicy,
    origin: {
      channel: record.scope.channel,
      surfaceId: record.scope.surfaceId,
    },
    ...(record.executionId ? { executionId: record.executionId } : {}),
    ...(record.rootExecutionId ? { rootExecutionId: record.rootExecutionId } : {}),
    ...(record.codeSessionId ? { codeSessionId: record.codeSessionId } : {}),
    ...(record.graphInterrupt ? { graphInterrupt: cloneGraphInterrupt(record.graphInterrupt) } : {}),
    blocker: {
      kind: record.blocker.kind,
      prompt,
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
      ...(summary ? { summary } : {}),
      ...(record.intent.turnRelation ? { turnRelation: record.intent.turnRelation } : {}),
      ...(record.intent.resolution ? { resolution: record.intent.resolution } : {}),
      ...(record.intent.missingFields?.length ? { missingFields: [...record.intent.missingFields] } : {}),
      originalUserContent: record.intent.originalUserContent,
      ...(record.intent.resolvedContent ? { resolvedContent: record.intent.resolvedContent } : {}),
      ...(record.intent.provenance ? { provenance: cloneIntent(record.intent).provenance } : {}),
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

  close(): void {
    this.db?.close();
    this.db = null;
    this.securityMonitor = null;
    this.insertOrReplaceStmt = null;
    this.rowByIdStmt = null;
    this.scopeRowsStmt = null;
    this.userRowsStmt = null;
    this.memory.records.clear();
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
    if (input.graphInterrupt) {
      record.graphInterrupt = cloneGraphInterrupt(input.graphInterrupt);
    }
    if (input.executionId?.trim()) {
      record.executionId = input.executionId.trim();
    }
    if (input.rootExecutionId?.trim()) {
      record.rootExecutionId = input.rootExecutionId.trim();
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
      ...(patch.graphInterrupt !== undefined
        ? (patch.graphInterrupt ? { graphInterrupt: cloneGraphInterrupt(patch.graphInterrupt) } : { graphInterrupt: undefined })
        : {}),
      ...(patch.executionId !== undefined
        ? (patch.executionId ? { executionId: patch.executionId } : { executionId: undefined })
        : {}),
      ...(patch.rootExecutionId !== undefined
        ? (patch.rootExecutionId ? { rootExecutionId: patch.rootExecutionId } : { rootExecutionId: undefined })
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
    return this.listActiveByApprovalId(approvalId, nowMs)[0] ?? null;
  }

  listActiveByApprovalId(approvalId: string, nowMs: number = this.now()): PendingActionRecord[] {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return [];
    return this.listAllRecords(nowMs)
      .filter((record) => isPendingActionActive(record.status))
      .filter((record) => record.blocker.approvalIds?.includes(normalizedId))
      .map((record) => cloneRecord(record));
  }
}

export function clearApprovalIdFromPendingAction(
  store: PendingActionStore,
  approvalId: string,
  nowMs: number = Date.now(),
): PendingActionRecord | null {
  const normalizedId = approvalId.trim();
  if (!normalizedId) return null;
  const activeRecords = store.listActiveByApprovalId(normalizedId, nowMs);
  let firstUpdated: PendingActionRecord | null = null;
  for (const active of activeRecords) {
    const remainingApprovalIds = (active.blocker.approvalIds ?? []).filter((id) => id !== normalizedId);
    const updated = remainingApprovalIds.length === 0
      ? store.complete(active.id, nowMs)
      : store.update(active.id, {
          blocker: {
            ...active.blocker,
            approvalIds: remainingApprovalIds,
            approvalSummaries: (active.blocker.approvalSummaries ?? [])
              .filter((summary) => summary.id !== normalizedId),
          },
          ...(active.resume?.kind === 'worker_approval' && Array.isArray(active.resume.payload.approvalIds)
            ? {
                resume: {
                  kind: active.resume.kind,
                  payload: {
                    ...active.resume.payload,
                    approvalIds: remainingApprovalIds,
                  },
                },
              }
            : {}),
        }, nowMs);
    if (!firstUpdated) {
      firstUpdated = updated;
    }
  }
  return firstUpdated;
}

function normalizeApprovalIds(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawId of ids ?? []) {
    const approvalId = rawId.trim();
    if (!approvalId || seen.has(approvalId)) continue;
    seen.add(approvalId);
    normalized.push(approvalId);
  }
  return normalized;
}

function buildApprovalSummaryMap(
  summaries: readonly PendingActionApprovalSummary[] | undefined,
): Map<string, PendingActionApprovalSummary> {
  const map = new Map<string, PendingActionApprovalSummary>();
  for (const summary of summaries ?? []) {
    const approvalId = summary.id.trim();
    if (!approvalId) continue;
    map.set(approvalId, {
      id: approvalId,
      toolName: summary.toolName,
      argsPreview: summary.argsPreview,
      ...(summary.actionLabel ? { actionLabel: summary.actionLabel } : {}),
    });
  }
  return map;
}

function approvalSummariesEqual(
  left: readonly PendingActionApprovalSummary[] | undefined,
  right: readonly PendingActionApprovalSummary[] | undefined,
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((summary, index) => {
    const other = normalizedRight[index];
    return other
      && summary.id === other.id
      && summary.toolName === other.toolName
      && summary.argsPreview === other.argsPreview
      && (summary.actionLabel ?? '') === (other.actionLabel ?? '');
  });
}

function buildReconciledApprovalSummaries(
  approvalIds: readonly string[],
  liveApprovalSummaries: ReadonlyMap<string, PendingActionApprovalSummary | {
    toolName: string;
    argsPreview: string;
    actionLabel?: string;
  }> | undefined,
  currentApprovalSummaries: readonly PendingActionApprovalSummary[] | undefined,
): PendingActionApprovalSummary[] {
  const currentSummaries = buildApprovalSummaryMap(currentApprovalSummaries);
  return approvalIds.map((approvalId) => {
    const liveSummary = liveApprovalSummaries?.get(approvalId);
    const currentSummary = currentSummaries.get(approvalId);
    return {
      id: approvalId,
      toolName: liveSummary?.toolName ?? currentSummary?.toolName ?? 'unknown',
      argsPreview: liveSummary?.argsPreview ?? currentSummary?.argsPreview ?? '',
      actionLabel: liveSummary?.actionLabel ?? currentSummary?.actionLabel ?? '',
    };
  });
}

export function reconcilePendingApprovalAction(
  store: PendingActionStore,
  pendingAction: PendingActionRecord | null | undefined,
  input: {
    liveApprovalIds: readonly string[];
    liveApprovalSummaries?: ReadonlyMap<string, PendingActionApprovalSummary | {
      toolName: string;
      argsPreview: string;
      actionLabel?: string;
    }>;
    /**
     * Scope-agnostic set of approval ids currently pending in the executor.
     * Used only to decide whether a pending action should be completed when
     * the scoped `liveApprovalIds` query returns empty. The pending action's
     * approval may live under a different scope (e.g. a code-session tool
     * call bound to a web-chat pending action), so a scoped miss is not a
     * safe signal for lifecycle cleanup.
     */
    allPendingApprovalIds?: readonly string[];
    scope?: PendingActionScope;
    nowMs?: number;
  },
): PendingActionRecord | null {
  const nowMs = input.nowMs ?? Date.now();
  const liveApprovalIds = normalizeApprovalIds(input.liveApprovalIds);
  const allPendingApprovalIds = input.allPendingApprovalIds
    ? new Set(normalizeApprovalIds(input.allPendingApprovalIds))
    : null;

  if (!pendingAction || !isPendingActionActive(pendingAction.status) || pendingAction.blocker.kind !== 'approval') {
    if (liveApprovalIds.length === 0) {
      return pendingAction ?? null;
    }
    const scope = input.scope ?? pendingAction?.scope;
    if (!scope) {
      return pendingAction ?? null;
    }
    const approvalSummaries = buildReconciledApprovalSummaries(
      liveApprovalIds,
      input.liveApprovalSummaries,
      pendingAction?.blocker.approvalSummaries,
    );
    const prompt = approvalSummaries.length > 0
      ? formatPendingApprovalMessage(approvalSummaries)
      : 'Approval required for the pending action.';
    return store.replaceActive(scope, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt,
        approvalIds: [...liveApprovalIds],
        ...(approvalSummaries.length > 0 ? { approvalSummaries } : {}),
      },
      intent: {
        ...(pendingAction?.intent.route ? { route: pendingAction.intent.route } : {}),
        ...(pendingAction?.intent.operation ? { operation: pendingAction.intent.operation } : {}),
        ...(pendingAction?.intent.summary ? { summary: pendingAction.intent.summary } : {}),
        ...(pendingAction?.intent.turnRelation ? { turnRelation: pendingAction.intent.turnRelation } : {}),
        ...(pendingAction?.intent.resolution ? { resolution: pendingAction.intent.resolution } : {}),
        ...(pendingAction?.intent.missingFields?.length ? { missingFields: [...pendingAction.intent.missingFields] } : {}),
        originalUserContent: pendingAction?.intent.originalUserContent ?? '',
        ...(pendingAction?.intent.resolvedContent ? { resolvedContent: pendingAction.intent.resolvedContent } : {}),
        ...(pendingAction?.intent.provenance ? {
          provenance: normalizeIntentGatewayDecisionProvenance(pendingAction.intent.provenance),
        } : {}),
        ...(pendingAction?.intent.entities ? { entities: { ...pendingAction.intent.entities } } : {}),
      },
      ...(pendingAction?.resume
        ? {
            resume: {
              kind: pendingAction.resume.kind,
              payload: { ...pendingAction.resume.payload },
            },
          }
        : {}),
      ...(pendingAction?.executionId ? { executionId: pendingAction.executionId } : {}),
      ...(pendingAction?.rootExecutionId ? { rootExecutionId: pendingAction.rootExecutionId } : {}),
      ...(pendingAction?.codeSessionId ? { codeSessionId: pendingAction.codeSessionId } : {}),
      expiresAt: nowMs + 30 * 60_000,
    }, nowMs);
  }

  const currentApprovalIds = normalizeApprovalIds(pendingAction.blocker.approvalIds);
  if (currentApprovalIds.length === 0) {
    return store.complete(pendingAction.id, nowMs);
  }

  const liveApprovalSet = new Set(liveApprovalIds);
  const remainingApprovalIds = currentApprovalIds.filter((approvalId) => liveApprovalSet.has(approvalId));
  if (remainingApprovalIds.length === 0) {
    // Cross-scope safety net: if any of the pending action's approval ids are
    // still pending anywhere in the executor (different scope than this
    // reconcile query), do not complete the pending action. This avoids losing
    // cross-scope work such as a web-chat pending action waiting on a
    // code-session-scoped coding_backend_run approval.
    if (allPendingApprovalIds) {
      const anyStillPending = currentApprovalIds.some((id) => allPendingApprovalIds.has(id));
      if (anyStillPending) {
        return pendingAction;
      }
    }
    return store.complete(pendingAction.id, nowMs);
  }

  const nextSummaries = buildReconciledApprovalSummaries(
    remainingApprovalIds,
    input.liveApprovalSummaries,
    pendingAction.blocker.approvalSummaries,
  );
  const approvalIdsChanged = remainingApprovalIds.length !== currentApprovalIds.length
    || remainingApprovalIds.some((approvalId, index) => approvalId !== currentApprovalIds[index]);
  const summariesChanged = approvalIdsChanged
    || !approvalSummariesEqual(pendingAction.blocker.approvalSummaries, nextSummaries);
  const nextPrompt = nextSummaries.length > 0
    ? formatPendingApprovalMessage(nextSummaries)
    : pendingAction.blocker.prompt;
  const promptChanged = nextPrompt !== pendingAction.blocker.prompt;
  if (!approvalIdsChanged && !summariesChanged && !promptChanged) {
    return pendingAction;
  }

  return store.update(pendingAction.id, {
    blocker: {
      ...pendingAction.blocker,
      prompt: nextPrompt,
      approvalIds: remainingApprovalIds,
      approvalSummaries: nextSummaries,
    },
  }, nowMs);
}
