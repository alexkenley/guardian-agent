import { posix as posixPath, win32 as win32Path } from 'node:path';

import type { AgentContext } from '../../agent/types.js';
import { isRecord, toString } from '../../chat-agent-helpers.js';
import type { PrincipalRole, ToolExecutionRequest } from '../../tools/types.js';

export const DIRECT_ROUTE_RESUME_TYPE_FILESYSTEM_SAVE_OUTPUT = 'filesystem_save_output';
export const DIRECT_ROUTE_RESUME_TYPE_SECOND_BRAIN_MUTATION = 'second_brain_mutation';
export const DIRECT_ROUTE_RESUME_TYPE_CODING_BACKEND_RUN = 'coding_backend_run';

export interface FilesystemSaveOutputResumePayload {
  type: typeof DIRECT_ROUTE_RESUME_TYPE_FILESYSTEM_SAVE_OUTPUT;
  targetPath: string;
  content: string;
  originalUserContent: string;
  allowPathRemediation: boolean;
  principalId?: string;
  principalRole?: string;
  codeContext?: {
    workspaceRoot: string;
    sessionId?: string;
  };
}

export type StoredSecondBrainMutationToolName =
  | 'second_brain_note_upsert'
  | 'second_brain_note_delete'
  | 'second_brain_task_upsert'
  | 'second_brain_task_delete'
  | 'second_brain_calendar_upsert'
  | 'second_brain_calendar_delete'
  | 'second_brain_person_upsert'
  | 'second_brain_person_delete'
  | 'second_brain_library_upsert'
  | 'second_brain_library_delete'
  | 'second_brain_brief_upsert'
  | 'second_brain_generate_brief'
  | 'second_brain_brief_update'
  | 'second_brain_brief_delete'
  | 'second_brain_routine_create'
  | 'second_brain_routine_update'
  | 'second_brain_routine_delete';

export type StoredSecondBrainMutationItemType =
  | 'note'
  | 'task'
  | 'calendar'
  | 'person'
  | 'library'
  | 'brief'
  | 'routine';

export type StoredSecondBrainMutationAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'complete';

export interface SecondBrainMutationResumePayload {
  type: typeof DIRECT_ROUTE_RESUME_TYPE_SECOND_BRAIN_MUTATION;
  toolName: StoredSecondBrainMutationToolName;
  args: Record<string, unknown>;
  originalUserContent: string;
  itemType: StoredSecondBrainMutationItemType;
  action: StoredSecondBrainMutationAction;
  fallbackId?: string;
  fallbackLabel?: string;
}

export interface CodingBackendRunResumePayload {
  type: typeof DIRECT_ROUTE_RESUME_TYPE_CODING_BACKEND_RUN;
  task: string;
  backendId?: string;
  codeSessionId?: string;
  workspaceRoot?: string;
}

export function buildDirectFilesystemToolRequest(input: {
  agentId: string;
  targetPath?: string;
  userId: string;
  channel: string;
  surfaceId?: string;
  principalId?: string;
  principalRole?: PrincipalRole;
  requestId: string;
  agentCheckAction?: AgentContext['checkAction'];
  codeContext?: { workspaceRoot: string; sessionId?: string };
}): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
  const scopedCodeContext = resolveDirectFilesystemSaveCodeContext(input.codeContext, input.targetPath);
  return {
    origin: 'assistant',
    agentId: input.agentId,
    userId: input.userId,
    channel: input.channel,
    surfaceId: input.surfaceId,
    principalId: input.principalId,
    principalRole: input.principalRole,
    requestId: input.requestId,
    ...(input.agentCheckAction ? { agentContext: { checkAction: input.agentCheckAction } } : {}),
    ...(scopedCodeContext ? { codeContext: scopedCodeContext } : {}),
  };
}

export function resolveDirectFilesystemSaveCodeContext(
  codeContext?: { workspaceRoot: string; sessionId?: string },
  targetPath?: string,
): { workspaceRoot: string; sessionId?: string } | undefined {
  const workspaceRoot = toString(codeContext?.workspaceRoot).trim();
  if (!workspaceRoot) return undefined;
  const requestedTarget = toString(targetPath).trim();
  if (!requestedTarget) return codeContext;
  return isFilesystemPathInsideWorkspace(requestedTarget, workspaceRoot)
    ? codeContext
    : undefined;
}

export function isFilesystemPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  try {
    const normalizedTarget = normalizeFilesystemPathForComparison(targetPath);
    const normalizedWorkspaceRoot = normalizeFilesystemPathForComparison(workspaceRoot);
    if (!normalizedTarget || !normalizedWorkspaceRoot) return true;
    const usesWindowsPaths = /^[a-z]:\\/i.test(normalizedTarget) || /^[a-z]:\\/i.test(normalizedWorkspaceRoot);
    const pathLib = usesWindowsPaths ? win32Path : posixPath;
    const resolvedTarget = pathLib.resolve(normalizedTarget);
    const resolvedRoot = pathLib.resolve(normalizedWorkspaceRoot);
    const comparableTarget = usesWindowsPaths ? resolvedTarget.toLowerCase() : resolvedTarget;
    const comparableRoot = usesWindowsPaths ? resolvedRoot.toLowerCase() : resolvedRoot;
    if (comparableTarget === comparableRoot) return true;
    const separator = usesWindowsPaths ? '\\' : '/';
    return comparableTarget.startsWith(
      comparableRoot.endsWith(separator) ? comparableRoot : `${comparableRoot}${separator}`,
    );
  } catch {
    return true;
  }
}

export function normalizeFilesystemPathForComparison(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return trimmed;
  if (process.platform === 'win32') {
    const mntMatch = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (mntMatch) {
      const drive = mntMatch[1].toUpperCase();
      const rest = mntMatch[2].replace(/\//g, '\\');
      return `${drive}:\\${rest}`;
    }
    return trimmed.replace(/\//g, '\\');
  }
  const driveMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  return trimmed.replace(/\\/g, '/');
}

export function readFilesystemSaveOutputResumePayload(
  payload: Record<string, unknown> | undefined,
): FilesystemSaveOutputResumePayload | null {
  if (!isRecord(payload)) return null;
  if (payload.type !== DIRECT_ROUTE_RESUME_TYPE_FILESYSTEM_SAVE_OUTPUT) return null;
  const targetPath = toString(payload.targetPath).trim();
  const content = toString(payload.content);
  const originalUserContent = toString(payload.originalUserContent).trim();
  if (!targetPath || !originalUserContent) return null;
  const codeContext = isRecord(payload.codeContext) && toString(payload.codeContext.workspaceRoot).trim()
    ? {
        workspaceRoot: toString(payload.codeContext.workspaceRoot).trim(),
        ...(toString(payload.codeContext.sessionId).trim()
          ? { sessionId: toString(payload.codeContext.sessionId).trim() }
          : {}),
      }
    : undefined;
  return {
    type: DIRECT_ROUTE_RESUME_TYPE_FILESYSTEM_SAVE_OUTPUT,
    targetPath,
    content,
    originalUserContent,
    allowPathRemediation: payload.allowPathRemediation === true,
    ...(toString(payload.principalId).trim() ? { principalId: toString(payload.principalId).trim() } : {}),
    ...(toString(payload.principalRole).trim() ? { principalRole: toString(payload.principalRole).trim() } : {}),
    ...(codeContext ? { codeContext } : {}),
  };
}

export function readSecondBrainMutationResumePayload(
  payload: Record<string, unknown> | undefined,
): SecondBrainMutationResumePayload | null {
  if (!isRecord(payload)) return null;
  if (payload.type !== DIRECT_ROUTE_RESUME_TYPE_SECOND_BRAIN_MUTATION) return null;
  const toolName = toString(payload.toolName).trim();
  const originalUserContent = toString(payload.originalUserContent).trim();
  const itemType = toString(payload.itemType).trim();
  const action = toString(payload.action).trim();
  if (!originalUserContent || !isRecord(payload.args)) return null;
  if (
    toolName !== 'second_brain_note_upsert'
    && toolName !== 'second_brain_note_delete'
    && toolName !== 'second_brain_task_upsert'
    && toolName !== 'second_brain_task_delete'
    && toolName !== 'second_brain_calendar_upsert'
    && toolName !== 'second_brain_calendar_delete'
    && toolName !== 'second_brain_person_upsert'
    && toolName !== 'second_brain_person_delete'
    && toolName !== 'second_brain_library_upsert'
    && toolName !== 'second_brain_library_delete'
    && toolName !== 'second_brain_brief_upsert'
    && toolName !== 'second_brain_generate_brief'
    && toolName !== 'second_brain_brief_update'
    && toolName !== 'second_brain_brief_delete'
    && toolName !== 'second_brain_routine_create'
    && toolName !== 'second_brain_routine_update'
    && toolName !== 'second_brain_routine_delete'
  ) {
    return null;
  }
  if (
    itemType !== 'note'
    && itemType !== 'task'
    && itemType !== 'calendar'
    && itemType !== 'person'
    && itemType !== 'library'
    && itemType !== 'brief'
    && itemType !== 'routine'
  ) {
    return null;
  }
  if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'complete') {
    return null;
  }
  return {
    type: DIRECT_ROUTE_RESUME_TYPE_SECOND_BRAIN_MUTATION,
    toolName,
    args: { ...payload.args },
    originalUserContent,
    itemType,
    action,
    ...(toString(payload.fallbackId).trim() ? { fallbackId: toString(payload.fallbackId).trim() } : {}),
    ...(toString(payload.fallbackLabel).trim() ? { fallbackLabel: toString(payload.fallbackLabel).trim() } : {}),
  };
}

export function isFilesystemPathPolicyError(message: string): boolean {
  const lower = message.trim().toLowerCase();
  if (!lower) return false;
  return lower.includes('outside allowed paths')
    || lower.includes('outside the authorized workspace root')
    || lower.includes('outside the authorized workspace');
}

export function getFilesystemPolicyRoot(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed) return trimmed;
  const pathApi = getFilesystemPathApi(trimmed);
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    return trimmed.replace(/[\\/]+$/, '');
  }
  const parent = pathApi.dirname(trimmed);
  return parent && parent !== '.' ? parent : trimmed;
}

export function getFilesystemPathApi(targetPath: string): typeof win32Path | typeof posixPath {
  return /^[a-zA-Z]:[\\/]/.test(targetPath) || targetPath.includes('\\')
    ? win32Path
    : posixPath;
}

export function normalizeFilesystemResumePrincipalRole(value: string | undefined): PrincipalRole | undefined {
  switch (value) {
    case 'owner':
    case 'operator':
    case 'approver':
    case 'viewer':
      return value;
    default:
      return undefined;
  }
}

export function readCodingBackendRunResumePayload(
  payload: Record<string, unknown> | undefined,
): CodingBackendRunResumePayload | null {
  if (!isRecord(payload)) return null;
  if (payload.type !== DIRECT_ROUTE_RESUME_TYPE_CODING_BACKEND_RUN) return null;
  const task = toString(payload.task).trim();
  if (!task) return null;
  return {
    type: DIRECT_ROUTE_RESUME_TYPE_CODING_BACKEND_RUN,
    task,
    backendId: toString(payload.backendId).trim() || undefined,
    codeSessionId: toString(payload.codeSessionId).trim() || undefined,
    workspaceRoot: toString(payload.workspaceRoot).trim() || undefined,
  };
}
