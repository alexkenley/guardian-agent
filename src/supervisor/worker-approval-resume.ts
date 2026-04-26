import type { UserMessage } from '../agent/types.js';
import type { DelegatedWorkerRunClass } from '../runtime/assistant-jobs.js';
import { normalizeOrchestrationRoleDescriptor, type OrchestrationRoleDescriptor } from '../runtime/orchestration-role-descriptors.js';
import type { PendingActionResume } from '../runtime/pending-actions.js';
import type { SelectedExecutionProfile } from '../runtime/execution-profiles.js';
import {
  readWorkerAutomationAuthoringResume,
  serializeWorkerAutomationAuthoringResume,
  type WorkerAutomationAuthoringResume,
} from '../worker/automation-resume.js';

export const WORKER_APPROVAL_RESUME_KIND = 'worker_approval' as const;

export interface WorkerApprovalResumePayload {
  workerId: string;
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

export function buildWorkerApprovalResumePayload(
  input: WorkerApprovalResumePayload,
): PendingActionResume {
  return {
    kind: WORKER_APPROVAL_RESUME_KIND,
    payload: serializeWorkerApprovalResumePayload(input),
  };
}

export function readWorkerApprovalResumePayload(
  resume: PendingActionResume | undefined | null,
): WorkerApprovalResumePayload | null {
  if (!resume || resume.kind !== WORKER_APPROVAL_RESUME_KIND) return null;
  return readWorkerApprovalResumePayloadRecord(resume.payload);
}

function serializeWorkerApprovalResumePayload(
  input: WorkerApprovalResumePayload,
): Record<string, unknown> {
  return {
    workerId: input.workerId,
    workerSessionKey: input.workerSessionKey,
    sessionId: input.sessionId,
    agentId: input.agentId,
    userId: input.userId,
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.originalUserContent ? { originalUserContent: input.originalUserContent } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.rootExecutionId ? { rootExecutionId: input.rootExecutionId } : {}),
    ...(input.originChannel ? { originChannel: input.originChannel } : {}),
    ...(input.originSurfaceId ? { originSurfaceId: input.originSurfaceId } : {}),
    ...(input.continuityKey ? { continuityKey: input.continuityKey } : {}),
    ...(input.activeExecutionRefs?.length ? { activeExecutionRefs: [...input.activeExecutionRefs] } : {}),
    ...(input.pendingActionId ? { pendingActionId: input.pendingActionId } : {}),
    ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    ...(input.runClass ? { runClass: input.runClass } : {}),
    ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.orchestration ? { orchestration: cloneOrchestration(input.orchestration) } : {}),
    ...(input.executionProfile ? { executionProfile: cloneExecutionProfile(input.executionProfile) } : {}),
    ...(input.automationResume ? { automationResume: serializeWorkerAutomationAuthoringResume(input.automationResume) } : {}),
    principalId: input.principalId,
    principalRole: input.principalRole,
    channel: input.channel,
    approvalIds: [...input.approvalIds],
    expiresAt: input.expiresAt,
  };
}

function readWorkerApprovalResumePayloadRecord(value: unknown): WorkerApprovalResumePayload | null {
  if (!isRecord(value)) return null;
  const workerId = readNonEmptyString(value.workerId);
  const workerSessionKey = readNonEmptyString(value.workerSessionKey);
  const sessionId = readNonEmptyString(value.sessionId);
  const agentId = readNonEmptyString(value.agentId);
  const userId = readNonEmptyString(value.userId);
  const principalId = readNonEmptyString(value.principalId);
  const principalRole = readPrincipalRole(value.principalRole);
  const channel = readNonEmptyString(value.channel);
  const approvalIds = readStringList(value.approvalIds);
  const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
    ? value.expiresAt
    : 0;
  if (
    !workerId
    || !workerSessionKey
    || !sessionId
    || !agentId
    || !userId
    || !principalId
    || !principalRole
    || !channel
    || approvalIds.length === 0
    || expiresAt <= 0
  ) {
    return null;
  }
  const orchestration = normalizeOrchestrationRoleDescriptor(value.orchestration);
  const executionProfile = readExecutionProfile(value.executionProfile);
  const automationResume = readWorkerAutomationAuthoringResume(value.automationResume);
  return {
    workerId,
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
    ...(orchestration ? { orchestration } : {}),
    ...(executionProfile ? { executionProfile } : {}),
    ...(automationResume ? { automationResume } : {}),
    principalId,
    principalRole,
    channel,
    approvalIds,
    expiresAt,
  };
}

function readExecutionProfile(value: unknown): SelectedExecutionProfile | undefined {
  if (!isRecord(value)) return undefined;
  const fallbackProviderOrder = readStringList(value.fallbackProviderOrder);
  const requiredText = [
    value.id,
    value.providerName,
    value.providerType,
    value.providerLocality,
    value.providerTier,
    value.requestedTier,
    value.preferredAnswerPath,
    value.expectedContextPressure,
    value.toolContextMode,
    value.reason,
  ].map(readNonEmptyString);
  if (requiredText.some((entry) => !entry)) return undefined;
  const contextBudget = readFiniteNumber(value.contextBudget);
  const maxAdditionalSections = readFiniteNumber(value.maxAdditionalSections);
  const maxRuntimeNotices = readFiniteNumber(value.maxRuntimeNotices);
  if (contextBudget === undefined || maxAdditionalSections === undefined || maxRuntimeNotices === undefined) {
    return undefined;
  }
  return {
    id: requiredText[0] as SelectedExecutionProfile['id'],
    providerName: requiredText[1],
    providerType: requiredText[2],
    ...(readNonEmptyString(value.providerModel) ? { providerModel: readNonEmptyString(value.providerModel) } : {}),
    providerLocality: requiredText[3] as SelectedExecutionProfile['providerLocality'],
    providerTier: requiredText[4] as SelectedExecutionProfile['providerTier'],
    requestedTier: requiredText[5] as SelectedExecutionProfile['requestedTier'],
    preferredAnswerPath: requiredText[6] as SelectedExecutionProfile['preferredAnswerPath'],
    expectedContextPressure: requiredText[7] as SelectedExecutionProfile['expectedContextPressure'],
    contextBudget,
    toolContextMode: requiredText[8] as SelectedExecutionProfile['toolContextMode'],
    maxAdditionalSections,
    maxRuntimeNotices,
    fallbackProviderOrder,
    reason: requiredText[9],
    ...(readNonEmptyString(value.routingMode) ? { routingMode: readNonEmptyString(value.routingMode) as SelectedExecutionProfile['routingMode'] } : {}),
    ...(readNonEmptyString(value.selectionSource) ? { selectionSource: readNonEmptyString(value.selectionSource) as SelectedExecutionProfile['selectionSource'] } : {}),
  };
}

function cloneExecutionProfile(profile: SelectedExecutionProfile): SelectedExecutionProfile {
  return {
    ...profile,
    fallbackProviderOrder: [...profile.fallbackProviderOrder],
  };
}

function cloneOrchestration(descriptor: OrchestrationRoleDescriptor): OrchestrationRoleDescriptor {
  return {
    role: descriptor.role,
    ...(descriptor.label ? { label: descriptor.label } : {}),
    ...(descriptor.lenses?.length ? { lenses: [...descriptor.lenses] } : {}),
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

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
