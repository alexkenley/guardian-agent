function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeCodeSessionId(value) {
  const trimmed = trimString(value);
  return trimmed || null;
}

export function findCodeSessionById(sessions, sessionId) {
  const normalizedSessionId = normalizeCodeSessionId(sessionId);
  if (!normalizedSessionId || !Array.isArray(sessions)) {
    return null;
  }
  return sessions.find((session) => normalizeCodeSessionId(session?.id) === normalizedSessionId) || null;
}

export function findReferencedCodeSessions(sessions, referencedSessionIds, currentSessionId = null) {
  const registry = Array.isArray(sessions) ? sessions : [];
  const currentId = normalizeCodeSessionId(currentSessionId);
  const referencedIds = Array.isArray(referencedSessionIds) ? referencedSessionIds : [];
  const resolved = [];
  for (const rawId of referencedIds) {
    const sessionId = normalizeCodeSessionId(rawId);
    if (!sessionId || (currentId && sessionId === currentId)) continue;
    const session = findCodeSessionById(registry, sessionId);
    if (!session || resolved.some((entry) => entry.id === session.id)) continue;
    resolved.push(session);
  }
  return resolved;
}

export function formatChatCodeSessionOptionLabel(session) {
  const title = trimString(session?.title) || 'Untitled coding workspace';
  const workspaceRoot = trimString(session?.workspaceRoot);
  return workspaceRoot ? `${title} - ${workspaceRoot}` : title;
}

export function shouldShowChatCodeSessionControls(context, locationHash = '') {
  return trimString(context) !== 'code' && !trimString(locationHash).startsWith('#/code');
}

export function summarizeReferencedChatCodeSessions(sessions, referencedSessionIds, currentSessionId = null) {
  const referenced = findReferencedCodeSessions(sessions, referencedSessionIds, currentSessionId);
  if (referenced.length === 0) {
    return {
      count: 0,
      summary: 'No referenced workspaces',
      detail: 'Add other repos as references in Code when you want inspect-only context without changing the mutable workspace.',
    };
  }
  const labels = referenced.map((session) => trimString(session.title) || trimString(session.workspaceRoot) || 'Untitled workspace');
  return {
    count: referenced.length,
    summary: referenced.length === 1 ? '1 referenced workspace' : `${referenced.length} referenced workspaces`,
    detail: labels.join(' | '),
  };
}

export function summarizeChatCodeSessionState({ sessions, currentSessionId } = {}) {
  const registry = Array.isArray(sessions) ? sessions : [];
  const currentSession = findCodeSessionById(registry, currentSessionId);
  const sessionCount = registry.length;

  if (currentSession) {
    return {
      badgeLabel: 'ATTACHED',
      badgeClassName: 'badge badge-info',
      summary: currentSession.title || 'Coding workspace attached',
      detail: trimString(currentSession.workspaceRoot) || 'Guardian chat will use this coding workspace by default.',
      currentSession,
      sessionCount,
    };
  }

  if (sessionCount > 0) {
    return {
      badgeLabel: 'DETACHED',
      badgeClassName: 'badge badge-idle',
      summary: 'No coding workspace attached',
      detail: 'Select a workspace here or open Code to inspect session activity.',
      currentSession: null,
      sessionCount,
    };
  }

  return {
    badgeLabel: 'NONE',
    badgeClassName: 'badge badge-idle',
    summary: 'No coding workspaces yet',
    detail: 'Open Code to create the first coding workspace for Guardian chat.',
    currentSession: null,
    sessionCount: 0,
  };
}
