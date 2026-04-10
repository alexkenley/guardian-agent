import type { CodeSessionRecord } from './code-sessions.js';
import { getEffectiveCodeWorkspaceTrustState } from './code-workspace-trust.js';

function normalizeCodeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeTargetCodeSessionId(input: {
  targetSessionId?: unknown;
  availableSessions?: readonly Pick<CodeSessionRecord, 'id'>[];
  currentSessionId?: string | null;
} = {}): string | null {
  const targetSessionId = normalizeCodeSessionId(input.targetSessionId);
  if (!targetSessionId) return null;
  const currentSessionId = normalizeCodeSessionId(input.currentSessionId);
  if (currentSessionId && targetSessionId === currentSessionId) {
    return null;
  }
  const availableIds = new Set(
    Array.isArray(input.availableSessions)
      ? input.availableSessions
        .map((session) => normalizeCodeSessionId(session?.id))
        .filter((sessionId): sessionId is string => !!sessionId)
      : [],
  );
  if (availableIds.size > 0 && !availableIds.has(targetSessionId)) {
    return null;
  }
  return targetSessionId;
}

export function normalizeReferencedCodeSessionIds(input: {
  referencedSessionIds?: unknown;
  availableSessions?: readonly Pick<CodeSessionRecord, 'id'>[];
  currentSessionId?: string | null;
  maxCount?: number;
} = {}): string[] {
  const availableIds = new Set(
    Array.isArray(input.availableSessions)
      ? input.availableSessions
        .map((session) => normalizeCodeSessionId(session?.id))
        .filter((sessionId): sessionId is string => !!sessionId)
      : [],
  );
  const currentSessionId = normalizeCodeSessionId(input.currentSessionId);
  const maxCount = Number.isFinite(input.maxCount) ? Math.max(0, Number(input.maxCount)) : 8;
  const requestedIds = Array.isArray(input.referencedSessionIds) ? input.referencedSessionIds : [];
  const normalized: string[] = [];

  for (const rawId of requestedIds) {
    const sessionId = normalizeCodeSessionId(rawId);
    if (!sessionId) continue;
    if (currentSessionId && sessionId === currentSessionId) continue;
    if (availableIds.size > 0 && !availableIds.has(sessionId)) continue;
    if (normalized.includes(sessionId)) continue;
    normalized.push(sessionId);
    if (normalized.length >= maxCount) {
      break;
    }
  }

  return normalized;
}

function summarizePortfolioSession(session: CodeSessionRecord): string {
  const effectiveTrustState = getEffectiveCodeWorkspaceTrustState(
    session.workState.workspaceTrust,
    session.workState.workspaceTrustReview,
  ) || session.workState.workspaceTrust?.state || 'unknown';
  const focusSummary = session.workState.focusSummary?.trim() || 'none';
  const workspaceSummary = session.workState.workspaceProfile?.summary?.trim() || 'No workspace summary yet.';
  return [
    `- title: ${session.title}`,
    `  sessionId: ${session.id}`,
    `  workspaceRoot: ${session.resolvedRoot}`,
    `  trust: ${effectiveTrustState}`,
    `  focusSummary: ${focusSummary}`,
    `  workspaceSummary: ${workspaceSummary}`,
  ].join('\n');
}

export function buildCodeSessionPortfolioAdditionalSection(input: {
  currentSession?: CodeSessionRecord | null;
  referencedSessions?: readonly CodeSessionRecord[];
  maxSessions?: number;
} = {}): string {
  const referencedSessions = Array.isArray(input.referencedSessions)
    ? input.referencedSessions.filter(Boolean)
    : [];
  const maxSessions = Number.isFinite(input.maxSessions) ? Math.max(0, Number(input.maxSessions)) : 4;
  const boundedSessions = referencedSessions.slice(0, maxSessions);
  if (!input.currentSession && boundedSessions.length === 0) {
    return '';
  }

  const lines = [
    '<code-session-portfolio>',
    'Guardian may inspect referenced coding workspaces, but implicit mutation still lands in exactly one primary workspace per lane.',
    input.currentSession
      ? `primaryWorkspace: ${input.currentSession.title} (${input.currentSession.resolvedRoot})`
      : 'primaryWorkspace: (none attached)',
    `referencedWorkspaceCount: ${referencedSessions.length}`,
  ];

  if (boundedSessions.length > 0) {
    lines.push('referencedWorkspaces:');
    for (const session of boundedSessions) {
      lines.push(summarizePortfolioSession(session));
    }
    if (referencedSessions.length > boundedSessions.length) {
      lines.push(`- additionalReferencedWorkspaces: ${referencedSessions.length - boundedSessions.length}`);
    }
  } else {
    lines.push('referencedWorkspaces: (none)');
  }

  lines.push('Use referenced workspaces for inspect, compare, summarize, and search-oriented reasoning.');
  lines.push('Do not edit files, run git actions, execute tests/builds, or issue shell mutations in a referenced workspace unless the user explicitly switches the primary workspace or pins another target.');
  lines.push('</code-session-portfolio>');
  return lines.join('\n');
}
