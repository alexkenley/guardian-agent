import { posix as posixPath, win32 as win32Path } from 'node:path';

import type { IntentGatewayDecision } from './intent-gateway.js';
import {
  isRawCredentialDisclosureRequest,
  looksLikeSelfContainedDirectAnswerTurn,
} from './intent/request-patterns.js';
import { extractPathHint } from './search-intent.js';

interface RequestedCodeContextLike {
  sessionId?: string;
  workspaceRoot?: string;
}

interface ResolvedCodeSessionLike {
  session: {
    id?: string;
    resolvedRoot: string;
  };
  attachment?: {
    channel: string;
    surfaceId: string;
  };
}

interface ShouldAttachCodeSessionForRequestInput {
  content: string;
  channel?: string;
  surfaceId?: string;
  requestedCodeContext?: RequestedCodeContextLike;
  resolvedCodeSession?: ResolvedCodeSessionLike | null;
  gatewayDecision?: Pick<IntentGatewayDecision, 'route' | 'requiresRepoGrounding'> | null;
}

interface CodeContextMetadataLike {
  codeContext?: unknown;
}

interface ShouldUseCodeSessionConversationInput {
  channel?: string;
  surfaceId?: string;
  requestedCodeContext?: RequestedCodeContextLike;
  resolvedCodeSession?: ResolvedCodeSessionLike | null;
  metadata?: unknown;
}

export const IMPLICIT_SHARED_CODE_CONTEXT_SOURCE = 'implicit_shared_attachment';

function usesWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\');
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const pathApi = usesWindowsPath(candidatePath) || usesWindowsPath(rootPath)
    ? win32Path
    : posixPath;
  const resolvedCandidate = pathApi.resolve(candidatePath);
  const resolvedRoot = pathApi.resolve(rootPath);
  const relativePath = pathApi.relative(resolvedRoot, resolvedCandidate);
  return relativePath === ''
    || (!relativePath.startsWith('..') && !pathApi.isAbsolute(relativePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isResolvedCodeSessionSharedAttachment(
  resolvedCodeSession: ResolvedCodeSessionLike | null | undefined,
  channel: string | undefined,
  surfaceId: string | undefined,
): boolean {
  const attachment = resolvedCodeSession?.attachment;
  if (!attachment) return false;
  if (!channel || !surfaceId) return false;
  return attachment.channel !== channel || attachment.surfaceId !== surfaceId;
}

export function isImplicitSharedCodeContextMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const codeContext = (metadata as CodeContextMetadataLike).codeContext;
  if (!isRecord(codeContext)) return false;
  return codeContext.source === IMPLICIT_SHARED_CODE_CONTEXT_SOURCE;
}

export function shouldUseCodeSessionConversationForRequest(
  input: ShouldUseCodeSessionConversationInput,
): boolean {
  if (!input.resolvedCodeSession) return false;
  if (!isResolvedCodeSessionCompatibleWithRequestedContext(
    input.requestedCodeContext,
    input.resolvedCodeSession,
  )) {
    return false;
  }
  if (isImplicitSharedCodeContextMetadata(input.metadata)) {
    return false;
  }
  if (input.requestedCodeContext?.sessionId) {
    return true;
  }
  return !isResolvedCodeSessionSharedAttachment(input.resolvedCodeSession, input.channel, input.surfaceId);
}

function hasExplicitPathOutsideWorkspace(
  content: string,
  workspaceRoot: string | undefined,
): boolean {
  if (!workspaceRoot) return false;
  const explicitPath = extractPathHint(content);
  if (!explicitPath) return false;
  return !isPathInsideRoot(explicitPath, workspaceRoot);
}

function isSelfContainedNonWorkspaceRequest(content: string): boolean {
  return looksLikeSelfContainedDirectAnswerTurn(content)
    || isRawCredentialDisclosureRequest(content);
}

export function isResolvedCodeSessionCompatibleWithRequestedContext(
  requestedCodeContext: RequestedCodeContextLike | null | undefined,
  resolvedCodeSession: ResolvedCodeSessionLike | null | undefined,
): boolean {
  const requestedSessionId = requestedCodeContext?.sessionId?.trim();
  if (requestedSessionId) {
    const resolvedSessionId = resolvedCodeSession?.session.id?.trim();
    if (!resolvedSessionId || resolvedSessionId !== requestedSessionId) {
      return false;
    }
  }
  const requestedWorkspaceRoot = requestedCodeContext?.workspaceRoot?.trim();
  if (!requestedWorkspaceRoot) return true;
  const resolvedWorkspaceRoot = resolvedCodeSession?.session.resolvedRoot?.trim();
  if (!resolvedWorkspaceRoot) return false;
  return isPathInsideRoot(requestedWorkspaceRoot, resolvedWorkspaceRoot)
    || isPathInsideRoot(resolvedWorkspaceRoot, requestedWorkspaceRoot);
}

export function shouldAttachCodeSessionForRequest(
  input: ShouldAttachCodeSessionForRequestInput,
): boolean {
  if (!input.resolvedCodeSession) return false;
  const gatewayDecision = input.gatewayDecision;
  if (gatewayDecision?.route === 'coding_session_control') {
    return false;
  }
  if (!isResolvedCodeSessionCompatibleWithRequestedContext(
    input.requestedCodeContext,
    input.resolvedCodeSession,
  )) {
    return false;
  }
  if (input.requestedCodeContext?.sessionId) {
    return true;
  }
  if (isSelfContainedNonWorkspaceRequest(input.content)) {
    return false;
  }

  const workspaceRoot = input.resolvedCodeSession.session.resolvedRoot?.trim();
  const sharedAttachment = isResolvedCodeSessionSharedAttachment(input.resolvedCodeSession, input.channel, input.surfaceId);
  if (hasExplicitPathOutsideWorkspace(input.content, workspaceRoot)) {
    return false;
  }

  if (!gatewayDecision) {
    return !sharedAttachment;
  }
  if (gatewayDecision.route === 'coding_task') {
    return true;
  }
  if (gatewayDecision.route === 'filesystem_task') {
    return true;
  }
  if (gatewayDecision.requiresRepoGrounding) {
    return !sharedAttachment;
  }
  return false;
}
