function normalizeCodeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeReferencedSessionIds({
  referencedSessionIds,
  sessions,
  currentSessionId,
} = {}) {
  const availableIds = new Set(
    Array.isArray(sessions)
      ? sessions.map((session) => normalizeCodeSessionId(session?.id)).filter(Boolean)
      : [],
  );
  const currentId = normalizeCodeSessionId(currentSessionId);
  const requestedIds = Array.isArray(referencedSessionIds) ? referencedSessionIds : [];
  const normalized = [];
  for (const rawId of requestedIds) {
    const sessionId = normalizeCodeSessionId(rawId);
    if (!sessionId || (currentId && sessionId === currentId)) continue;
    if (availableIds.size > 0 && !availableIds.has(sessionId)) continue;
    if (normalized.includes(sessionId)) continue;
    normalized.push(sessionId);
  }
  return normalized;
}

export function isReferencedSession(sessionId, referencedSessionIds, currentSessionId = null) {
  const normalizedSessionId = normalizeCodeSessionId(sessionId);
  if (!normalizedSessionId) return false;
  return normalizeReferencedSessionIds({
    referencedSessionIds,
    currentSessionId,
  }).includes(normalizedSessionId);
}
