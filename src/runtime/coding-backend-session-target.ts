import {
  resolveCodeSessionTarget,
  type CodeSessionTargetRecord,
} from './code-session-targets.js';

const GENERIC_SESSION_TARGET_TOKENS = new Set([
  'a',
  'active',
  'an',
  'attached',
  'code',
  'coding',
  'current',
  'currently',
  'my',
  'project',
  'repo',
  'repository',
  'session',
  'sessions',
  'that',
  'the',
  'this',
  'workspace',
  'workspaces',
]);

export type CodingBackendSessionTargetResolution =
  | {
      status: 'none';
      currentSession?: CodeSessionTargetRecord;
    }
  | {
      status: 'current';
      currentSession?: CodeSessionTargetRecord;
      targetSession: CodeSessionTargetRecord;
    }
  | {
      status: 'switch_required';
      currentSession?: CodeSessionTargetRecord;
      targetSession: CodeSessionTargetRecord;
      requestedSessionTarget: string;
    }
  | {
      status: 'target_unresolved';
      currentSession?: CodeSessionTargetRecord;
      requestedSessionTarget: string;
      error: string;
    };

export function resolveCodingBackendSessionTarget(input: {
  requestedSessionTarget?: string | null;
  currentSessionId?: string | null;
  sessions: CodeSessionTargetRecord[];
}): CodingBackendSessionTargetResolution {
  const requestedSessionTarget = normalizeRequestedSessionTarget(input.requestedSessionTarget);
  const currentSession = input.currentSessionId
    ? input.sessions.find((session) => session.id === input.currentSessionId)
    : undefined;

  if (!requestedSessionTarget) {
    return {
      status: 'none',
      ...(currentSession ? { currentSession } : {}),
    };
  }

  if (currentSession) {
    const currentResolved = resolveCodeSessionTarget(requestedSessionTarget, [currentSession]);
    if (currentResolved.session) {
      return {
        status: 'current',
        currentSession,
        targetSession: currentSession,
      };
    }
  }

  const resolved = resolveCodeSessionTarget(requestedSessionTarget, input.sessions);
  if (!resolved.session) {
    return {
      status: 'target_unresolved',
      requestedSessionTarget,
      error: resolved.error ?? `No coding session matched "${requestedSessionTarget}".`,
      ...(currentSession ? { currentSession } : {}),
    };
  }

  if (currentSession && resolved.session.id === currentSession.id) {
    return {
      status: 'current',
      currentSession,
      targetSession: resolved.session,
    };
  }

  return {
    status: 'switch_required',
    requestedSessionTarget,
    targetSession: resolved.session,
    ...(currentSession ? { currentSession } : {}),
  };
}

function normalizeRequestedSessionTarget(value?: string | null): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^[Tt]he\s+/, '')
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  const semanticTokens = cleaned
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter((token) => !GENERIC_SESSION_TARGET_TOKENS.has(token));
  return semanticTokens.length > 0 ? cleaned : undefined;
}
