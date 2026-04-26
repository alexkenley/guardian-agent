import type { UserMessage } from '../agent/types.js';

const WORKER_AUTOMATION_AUTHORING_RESUME_KEY = 'workerAutomationAuthoringResume';

export interface WorkerAutomationAuthoringResume {
  originalUserContent: string;
  userId: string;
  channel: string;
  principalId?: string;
  principalRole?: UserMessage['principalRole'];
  surfaceId?: string;
  requestId?: string;
  codeContext?: {
    workspaceRoot: string;
    sessionId?: string;
  };
  allowRemediation?: boolean;
}

export function buildWorkerAutomationAuthoringResume(
  message: UserMessage,
  options?: { allowRemediation?: boolean },
): WorkerAutomationAuthoringResume {
  const codeContext = readCodeContext(message.metadata);
  return {
    originalUserContent: message.content,
    userId: message.userId,
    channel: message.channel,
    principalId: message.principalId,
    principalRole: message.principalRole,
    surfaceId: message.surfaceId,
    requestId: message.id,
    ...(codeContext ? { codeContext } : {}),
    allowRemediation: options?.allowRemediation ?? true,
  };
}

export function attachWorkerAutomationAuthoringResumeMetadata(
  metadata: Record<string, unknown> | undefined,
  resume: WorkerAutomationAuthoringResume,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [WORKER_AUTOMATION_AUTHORING_RESUME_KEY]: serializeWorkerAutomationAuthoringResume(resume),
  };
}

export function readWorkerAutomationAuthoringResumeMetadata(
  metadata: Record<string, unknown> | undefined,
): WorkerAutomationAuthoringResume | null {
  if (!metadata) return null;
  return readWorkerAutomationAuthoringResume(metadata[WORKER_AUTOMATION_AUTHORING_RESUME_KEY]);
}

export function buildWorkerAutomationAuthoringResumeMessage(
  message: UserMessage,
  resume: WorkerAutomationAuthoringResume,
): UserMessage {
  return {
    ...message,
    id: resume.requestId?.trim() || message.id,
    userId: resume.userId,
    principalId: resume.principalId ?? message.principalId ?? resume.userId,
    principalRole: resume.principalRole ?? message.principalRole,
    channel: resume.channel,
    ...(resume.surfaceId ? { surfaceId: resume.surfaceId } : {}),
    content: resume.originalUserContent,
    metadata: {
      ...(message.metadata ?? {}),
      ...(resume.codeContext ? { codeContext: { ...resume.codeContext } } : {}),
    },
  };
}

function serializeWorkerAutomationAuthoringResume(
  resume: WorkerAutomationAuthoringResume,
): Record<string, unknown> {
  return {
    originalUserContent: resume.originalUserContent,
    userId: resume.userId,
    channel: resume.channel,
    ...(resume.principalId ? { principalId: resume.principalId } : {}),
    ...(resume.principalRole ? { principalRole: resume.principalRole } : {}),
    ...(resume.surfaceId ? { surfaceId: resume.surfaceId } : {}),
    ...(resume.requestId ? { requestId: resume.requestId } : {}),
    ...(resume.codeContext ? { codeContext: { ...resume.codeContext } } : {}),
    ...(typeof resume.allowRemediation === 'boolean' ? { allowRemediation: resume.allowRemediation } : {}),
  };
}

function readWorkerAutomationAuthoringResume(value: unknown): WorkerAutomationAuthoringResume | null {
  if (!isRecord(value)) return null;
  const originalUserContent = readNonEmptyString(value.originalUserContent);
  const userId = readNonEmptyString(value.userId);
  const channel = readNonEmptyString(value.channel);
  if (!originalUserContent || !userId || !channel) return null;
  const codeContext = readCodeContext(value);
  return {
    originalUserContent,
    userId,
    channel,
    ...(readNonEmptyString(value.principalId) ? { principalId: readNonEmptyString(value.principalId) } : {}),
    ...(readPrincipalRole(value.principalRole) ? { principalRole: readPrincipalRole(value.principalRole) } : {}),
    ...(readNonEmptyString(value.surfaceId) ? { surfaceId: readNonEmptyString(value.surfaceId) } : {}),
    ...(readNonEmptyString(value.requestId) ? { requestId: readNonEmptyString(value.requestId) } : {}),
    ...(codeContext ? { codeContext } : {}),
    ...(typeof value.allowRemediation === 'boolean' ? { allowRemediation: value.allowRemediation } : {}),
  };
}

function readCodeContext(value: unknown): WorkerAutomationAuthoringResume['codeContext'] | undefined {
  const metadata = isRecord(value) ? value : null;
  const raw = isRecord(metadata?.codeContext) ? metadata.codeContext : null;
  const workspaceRoot = readNonEmptyString(raw?.workspaceRoot);
  if (!workspaceRoot) return undefined;
  const sessionId = readNonEmptyString(raw?.sessionId);
  return {
    workspaceRoot,
    ...(sessionId ? { sessionId } : {}),
  };
}

function readPrincipalRole(value: unknown): UserMessage['principalRole'] | undefined {
  return value === 'owner' || value === 'operator' || value === 'approver' || value === 'viewer'
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
