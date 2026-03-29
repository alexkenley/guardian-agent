import {
  resolveCodeSessionTarget,
  type CodeSessionTargetRecord,
} from './code-session-targets.js';

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
  const requestedSessionTarget = input.requestedSessionTarget?.trim();
  const currentSession = input.currentSessionId
    ? input.sessions.find((session) => session.id === input.currentSessionId)
    : undefined;

  if (!requestedSessionTarget) {
    return {
      status: 'none',
      ...(currentSession ? { currentSession } : {}),
    };
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
