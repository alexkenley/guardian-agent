function normalizeCodeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isViewingSession(activeSessionId, attachedSessionId) {
  const normalizedActiveSessionId = normalizeCodeSessionId(activeSessionId);
  const normalizedAttachedSessionId = normalizeCodeSessionId(attachedSessionId);
  return !!normalizedActiveSessionId
    && !!normalizedAttachedSessionId
    && normalizedActiveSessionId !== normalizedAttachedSessionId;
}

export function resolveWorkbenchActiveSessionId({
  sessionIds,
  previousActiveSessionId,
  previousAttachedSessionId,
  serverCurrentSessionId,
  preferredCurrentSessionId,
} = {}) {
  const normalizedSessionIds = Array.isArray(sessionIds)
    ? sessionIds.map((value) => normalizeCodeSessionId(value)).filter(Boolean)
    : [];
  const hasSession = (sessionId) => normalizedSessionIds.includes(normalizeCodeSessionId(sessionId));
  const preferredSessionId = normalizeCodeSessionId(preferredCurrentSessionId);
  if (preferredSessionId && hasSession(preferredSessionId)) {
    return preferredSessionId;
  }

  const normalizedPreviousActiveSessionId = normalizeCodeSessionId(previousActiveSessionId);
  const normalizedPreviousAttachedSessionId = normalizeCodeSessionId(previousAttachedSessionId);
  if (isViewingSession(normalizedPreviousActiveSessionId, normalizedPreviousAttachedSessionId)
    && hasSession(normalizedPreviousActiveSessionId)) {
    return normalizedPreviousActiveSessionId;
  }

  const normalizedServerCurrentSessionId = normalizeCodeSessionId(serverCurrentSessionId);
  if (normalizedServerCurrentSessionId && hasSession(normalizedServerCurrentSessionId)) {
    return normalizedServerCurrentSessionId;
  }

  if (normalizedPreviousActiveSessionId && hasSession(normalizedPreviousActiveSessionId)) {
    return normalizedPreviousActiveSessionId;
  }

  return normalizedSessionIds[0] || null;
}
