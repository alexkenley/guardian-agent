export interface CodeSessionTargetRecord {
  id: string;
  title: string;
  workspaceRoot: string;
  resolvedRoot?: string | null;
}

function normalizeCodeSessionTarget(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveMatchSet<T>(matches: T[], query: string): { session?: T; error?: string } | null {
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length > 1) {
    return { error: `More than one coding session matches "${query}". Use a more specific id or path.` };
  }
  return null;
}

export function resolveCodeSessionTarget<T extends CodeSessionTargetRecord>(
  query: string,
  sessions: T[],
): { session?: T; error?: string } {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { error: 'Attach requires a session id, title, or workspace match.' };
  }

  const exactId = sessions.find((session) => session.id.toLowerCase() === needle);
  if (exactId) return { session: exactId };

  const exactLabelMatches = sessions.filter((session) => (
    session.title.toLowerCase() === needle
    || session.workspaceRoot.toLowerCase() === needle
    || session.resolvedRoot?.toLowerCase() === needle
  ));
  const exactLabelResult = resolveMatchSet(exactLabelMatches, query);
  if (exactLabelResult) return exactLabelResult;

  const fuzzyMatches = sessions.filter((session) => (
    session.id.toLowerCase().includes(needle)
    || session.title.toLowerCase().includes(needle)
    || session.workspaceRoot.toLowerCase().includes(needle)
    || session.resolvedRoot?.toLowerCase().includes(needle)
  ));
  const fuzzyResult = resolveMatchSet(fuzzyMatches, query);
  if (fuzzyResult) return fuzzyResult;

  const normalizedNeedle = normalizeCodeSessionTarget(query);
  if (!normalizedNeedle) {
    return { error: 'Attach requires a session id, title, or workspace match.' };
  }

  const normalizedExactMatches = sessions.filter((session) => (
    normalizeCodeSessionTarget(session.id) === normalizedNeedle
    || normalizeCodeSessionTarget(session.title) === normalizedNeedle
    || normalizeCodeSessionTarget(session.workspaceRoot) === normalizedNeedle
    || normalizeCodeSessionTarget(session.resolvedRoot ?? '') === normalizedNeedle
  ));
  const normalizedExactResult = resolveMatchSet(normalizedExactMatches, query);
  if (normalizedExactResult) return normalizedExactResult;

  const normalizedFuzzyMatches = sessions.filter((session) => (
    normalizeCodeSessionTarget(session.id).includes(normalizedNeedle)
    || normalizeCodeSessionTarget(session.title).includes(normalizedNeedle)
    || normalizeCodeSessionTarget(session.workspaceRoot).includes(normalizedNeedle)
    || normalizeCodeSessionTarget(session.resolvedRoot ?? '').includes(normalizedNeedle)
  ));
  const normalizedFuzzyResult = resolveMatchSet(normalizedFuzzyMatches, query);
  if (normalizedFuzzyResult) return normalizedFuzzyResult;

  return { error: `No coding session matched "${query}".` };
}
