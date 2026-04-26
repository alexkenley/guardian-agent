import type { UserMessage } from '../agent/types.js';
import type { ChatMessage } from '../llm/types.js';
import type { SelectedExecutionProfile } from './execution-profiles.js';
import type { DelegatedWorkerRunClass } from './assistant-jobs.js';
import type { OrchestrationRoleDescriptor } from './orchestration-role-descriptors.js';
import type { DelegatedTaskContract } from './execution/types.js';
import type { ExecutionPlan } from './planner/types.js';
import type { WorkerAutomationAuthoringResume } from '../worker/automation-resume.js';

export const WORKER_SUSPENSION_METADATA_KEY = 'workerSuspension' as const;
export const WORKER_SUSPENSION_SCHEMA_VERSION = 1 as const;

export interface SerializedSuspendedToolCall {
  approvalId: string;
  toolCallId: string;
  jobId: string;
  name: string;
}

export interface SerializedSuspendedPlannerNode {
  nodeId: string;
  approvalId: string;
  jobId: string;
  toolName: string;
}

export interface SerializedPlannerTrustSnapshot {
  contentTrustLevel: 'trusted' | 'low_trust' | 'quarantined';
  taintReasons: string[];
}

export interface SerializedToolLoopWorkerSuspension {
  version: typeof WORKER_SUSPENSION_SCHEMA_VERSION;
  kind: 'tool_loop';
  llmMessages: ChatMessage[];
  pendingTools: SerializedSuspendedToolCall[];
  originalMessage: UserMessage;
  taskContract?: DelegatedTaskContract;
  executionProfile?: SelectedExecutionProfile;
  createdAt: number;
  expiresAt: number;
}

export interface SerializedPlannerWorkerSuspension {
  version: typeof WORKER_SUSPENSION_SCHEMA_VERSION;
  kind: 'planner';
  plan: ExecutionPlan;
  pendingNodes: SerializedSuspendedPlannerNode[];
  originalMessage: UserMessage;
  trustState: SerializedPlannerTrustSnapshot;
  executionProfile?: SelectedExecutionProfile;
  createdAt: number;
  expiresAt: number;
}

export type SerializedWorkerSuspensionSession =
  | SerializedToolLoopWorkerSuspension
  | SerializedPlannerWorkerSuspension;

export interface WorkerSuspensionResumeContext {
  workerId?: string;
  workerSessionKey: string;
  sessionId: string;
  agentId: string;
  userId: string;
  surfaceId?: string;
  originalUserContent?: string;
  requestId?: string;
  messageId?: string;
  executionId?: string;
  rootExecutionId?: string;
  originChannel?: string;
  originSurfaceId?: string;
  continuityKey?: string;
  activeExecutionRefs?: string[];
  pendingActionId?: string;
  codeSessionId?: string;
  runClass?: DelegatedWorkerRunClass;
  taskRunId?: string;
  agentName?: string;
  orchestration?: OrchestrationRoleDescriptor;
  executionProfile?: SelectedExecutionProfile;
  automationResume?: WorkerAutomationAuthoringResume;
  principalId: string;
  principalRole: NonNullable<UserMessage['principalRole']>;
  channel: string;
  approvalIds: string[];
  expiresAt: number;
}

export interface WorkerSuspensionEnvelope {
  version: typeof WORKER_SUSPENSION_SCHEMA_VERSION;
  resume: WorkerSuspensionResumeContext;
  session: SerializedWorkerSuspensionSession;
}

export function attachWorkerSuspensionMetadata(
  metadata: Record<string, unknown>,
  suspension: SerializedWorkerSuspensionSession,
): Record<string, unknown> {
  return {
    ...metadata,
    [WORKER_SUSPENSION_METADATA_KEY]: serializeWorkerSuspensionSession(suspension),
  };
}

export function readWorkerSuspensionMetadata(
  metadata: Record<string, unknown> | undefined,
): SerializedWorkerSuspensionSession | null {
  return readWorkerSuspensionSession(metadata?.[WORKER_SUSPENSION_METADATA_KEY]);
}

export function buildWorkerSuspensionEnvelope(input: {
  resume: WorkerSuspensionResumeContext;
  session: SerializedWorkerSuspensionSession;
}): WorkerSuspensionEnvelope {
  return {
    version: WORKER_SUSPENSION_SCHEMA_VERSION,
    resume: clonePlain(input.resume),
    session: serializeWorkerSuspensionSession(input.session),
  };
}

export function serializeWorkerSuspensionEnvelope(
  envelope: WorkerSuspensionEnvelope,
): Record<string, unknown> {
  return clonePlain(envelope) as unknown as Record<string, unknown>;
}

export function readWorkerSuspensionEnvelope(value: unknown): WorkerSuspensionEnvelope | null {
  if (!isRecord(value) || value.version !== WORKER_SUSPENSION_SCHEMA_VERSION) return null;
  const resume = readWorkerSuspensionResumeContext(value.resume);
  const session = readWorkerSuspensionSession(value.session);
  if (!resume || !session) return null;
  return {
    version: WORKER_SUSPENSION_SCHEMA_VERSION,
    resume,
    session,
  };
}

export function serializeWorkerSuspensionSession(
  suspension: SerializedWorkerSuspensionSession,
): SerializedWorkerSuspensionSession {
  return clonePlain(suspension);
}

export function readWorkerSuspensionSession(value: unknown): SerializedWorkerSuspensionSession | null {
  if (!isRecord(value) || value.version !== WORKER_SUSPENSION_SCHEMA_VERSION) return null;
  const originalMessage = readUserMessage(value.originalMessage);
  const createdAt = readFiniteNumber(value.createdAt);
  const expiresAt = readFiniteNumber(value.expiresAt);
  if (!originalMessage || createdAt === null || expiresAt === null || expiresAt <= 0) return null;
  if (value.kind === 'tool_loop') {
    const pendingTools = readSuspendedToolCalls(value.pendingTools);
    const llmMessages = readChatMessages(value.llmMessages);
    if (pendingTools.length === 0 || llmMessages.length === 0) return null;
    return {
      version: WORKER_SUSPENSION_SCHEMA_VERSION,
      kind: 'tool_loop',
      llmMessages,
      pendingTools,
      originalMessage,
      ...(isRecord(value.taskContract) ? { taskContract: clonePlain(value.taskContract) as unknown as DelegatedTaskContract } : {}),
      ...(isRecord(value.executionProfile) ? { executionProfile: clonePlain(value.executionProfile) as unknown as SelectedExecutionProfile } : {}),
      createdAt,
      expiresAt,
    };
  }
  if (value.kind === 'planner') {
    const pendingNodes = readSuspendedPlannerNodes(value.pendingNodes);
    const plan = isRecord(value.plan) ? clonePlain(value.plan) as unknown as ExecutionPlan : null;
    const trustState = readPlannerTrustSnapshot(value.trustState);
    if (!plan || pendingNodes.length === 0 || !trustState) return null;
    return {
      version: WORKER_SUSPENSION_SCHEMA_VERSION,
      kind: 'planner',
      plan,
      pendingNodes,
      originalMessage,
      trustState,
      ...(isRecord(value.executionProfile) ? { executionProfile: clonePlain(value.executionProfile) as unknown as SelectedExecutionProfile } : {}),
      createdAt,
      expiresAt,
    };
  }
  return null;
}

function readWorkerSuspensionResumeContext(value: unknown): WorkerSuspensionResumeContext | null {
  if (!isRecord(value)) return null;
  const workerSessionKey = readNonEmptyString(value.workerSessionKey);
  const sessionId = readNonEmptyString(value.sessionId);
  const agentId = readNonEmptyString(value.agentId);
  const userId = readNonEmptyString(value.userId);
  const principalId = readNonEmptyString(value.principalId);
  const principalRole = readPrincipalRole(value.principalRole);
  const channel = readNonEmptyString(value.channel);
  const approvalIds = readStringList(value.approvalIds);
  const expiresAt = readFiniteNumber(value.expiresAt);
  if (
    !workerSessionKey
    || !sessionId
    || !agentId
    || !userId
    || !principalId
    || !principalRole
    || !channel
    || approvalIds.length === 0
    || expiresAt === null
    || expiresAt <= 0
  ) {
    return null;
  }
  return {
    ...(readNonEmptyString(value.workerId) ? { workerId: readNonEmptyString(value.workerId) } : {}),
    workerSessionKey,
    sessionId,
    agentId,
    userId,
    ...(readNonEmptyString(value.surfaceId) ? { surfaceId: readNonEmptyString(value.surfaceId) } : {}),
    ...(readNonEmptyString(value.originalUserContent) ? { originalUserContent: readNonEmptyString(value.originalUserContent) } : {}),
    ...(readNonEmptyString(value.requestId) ? { requestId: readNonEmptyString(value.requestId) } : {}),
    ...(readNonEmptyString(value.messageId) ? { messageId: readNonEmptyString(value.messageId) } : {}),
    ...(readNonEmptyString(value.executionId) ? { executionId: readNonEmptyString(value.executionId) } : {}),
    ...(readNonEmptyString(value.rootExecutionId) ? { rootExecutionId: readNonEmptyString(value.rootExecutionId) } : {}),
    ...(readNonEmptyString(value.originChannel) ? { originChannel: readNonEmptyString(value.originChannel) } : {}),
    ...(readNonEmptyString(value.originSurfaceId) ? { originSurfaceId: readNonEmptyString(value.originSurfaceId) } : {}),
    ...(readNonEmptyString(value.continuityKey) ? { continuityKey: readNonEmptyString(value.continuityKey) } : {}),
    ...(readStringList(value.activeExecutionRefs).length ? { activeExecutionRefs: readStringList(value.activeExecutionRefs) } : {}),
    ...(readNonEmptyString(value.pendingActionId) ? { pendingActionId: readNonEmptyString(value.pendingActionId) } : {}),
    ...(readNonEmptyString(value.codeSessionId) ? { codeSessionId: readNonEmptyString(value.codeSessionId) } : {}),
    ...(readRunClass(value.runClass) ? { runClass: readRunClass(value.runClass) } : {}),
    ...(readNonEmptyString(value.taskRunId) ? { taskRunId: readNonEmptyString(value.taskRunId) } : {}),
    ...(readNonEmptyString(value.agentName) ? { agentName: readNonEmptyString(value.agentName) } : {}),
    ...(isRecord(value.orchestration) ? { orchestration: clonePlain(value.orchestration) as unknown as OrchestrationRoleDescriptor } : {}),
    ...(isRecord(value.executionProfile) ? { executionProfile: clonePlain(value.executionProfile) as unknown as SelectedExecutionProfile } : {}),
    ...(isRecord(value.automationResume) ? { automationResume: clonePlain(value.automationResume) as unknown as WorkerAutomationAuthoringResume } : {}),
    principalId,
    principalRole,
    channel,
    approvalIds,
    expiresAt,
  };
}

function readUserMessage(value: unknown): UserMessage | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const userId = readNonEmptyString(value.userId);
  const channel = readNonEmptyString(value.channel);
  const timestamp = readFiniteNumber(value.timestamp);
  if (!id || !userId || !channel || timestamp === null) return null;
  return clonePlain(value) as unknown as UserMessage;
}

function readChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((item) => typeof item.role === 'string')
    .map((item) => clonePlain(item) as unknown as ChatMessage);
}

function readSuspendedToolCalls(value: unknown): SerializedSuspendedToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const approvalId = readNonEmptyString(item.approvalId);
      const toolCallId = readNonEmptyString(item.toolCallId);
      const jobId = readNonEmptyString(item.jobId);
      const name = readNonEmptyString(item.name);
      if (!approvalId || !toolCallId || !jobId || !name) return null;
      return { approvalId, toolCallId, jobId, name };
    })
    .filter((item): item is SerializedSuspendedToolCall => !!item);
}

function readSuspendedPlannerNodes(value: unknown): SerializedSuspendedPlannerNode[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const nodeId = readNonEmptyString(item.nodeId);
      const approvalId = readNonEmptyString(item.approvalId);
      const jobId = readNonEmptyString(item.jobId);
      const toolName = readNonEmptyString(item.toolName);
      if (!nodeId || !approvalId || !jobId || !toolName) return null;
      return { nodeId, approvalId, jobId, toolName };
    })
    .filter((item): item is SerializedSuspendedPlannerNode => !!item);
}

function readPlannerTrustSnapshot(value: unknown): SerializedPlannerTrustSnapshot | null {
  if (!isRecord(value)) return null;
  const contentTrustLevel = value.contentTrustLevel === 'low_trust' || value.contentTrustLevel === 'quarantined'
    ? value.contentTrustLevel
    : value.contentTrustLevel === 'trusted'
      ? 'trusted'
      : null;
  if (!contentTrustLevel) return null;
  return {
    contentTrustLevel,
    taintReasons: readStringList(value.taintReasons),
  };
}

function readRunClass(value: unknown): DelegatedWorkerRunClass | undefined {
  return value === 'in_invocation'
    || value === 'short_lived'
    || value === 'long_running'
    || value === 'automation_owned'
    ? value
    : undefined;
}

function readPrincipalRole(value: unknown): NonNullable<UserMessage['principalRole']> | undefined {
  return value === 'owner' || value === 'operator' || value === 'approver' || value === 'viewer'
    ? value
    : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(readNonEmptyString).filter(Boolean))];
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
