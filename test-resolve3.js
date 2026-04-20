const GENERIC_CODE_SESSION_TOKENS = new Set([
  'a', 'an', 'the', 'my', 'this', 'that', 'workspace', 'workspaces', 'session', 'sessions', 'coding', 'code', 'project', 'repo', 'repository',
]);

function normalizeCodeSessionTarget(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeSemanticCodeSessionTarget(value) {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter((token) => !GENERIC_CODE_SESSION_TOKENS.has(token))
    .join('');
}

function resolveMatchSet(matches, query) {
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length > 1) {
    return { error: `More than one coding session matches "${query}". Use a more specific id or path.` };
  }
  return null;
}

const sessions = [
  { id: 'da47...', title: 'Guardian Agent', workspaceRoot: 'S:\\Development\\GuardianAgent' },
  { id: 'c763...', title: 'TempInstallTest', workspaceRoot: 'S:\\Development\\GuardianAgent\\tmp\\guardian-ui-package-test' }
];

function resolveCodeSessionTarget(query, sessions) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { error: 'Code session target is empty.' };
  }

  const exactMatches = sessions.filter((session) => (
    session.id === needle
    || session.title.toLowerCase() === needle
    || session.workspaceRoot.toLowerCase() === needle
    || (session.resolvedRoot && session.resolvedRoot.toLowerCase() === needle)
  ));
  const exactResult = resolveMatchSet(exactMatches, query);
  if (exactResult) return exactResult;

  const fuzzyMatches = sessions.filter((session) => (
    session.id.includes(needle)
    || session.title.toLowerCase().includes(needle)
    || session.workspaceRoot.toLowerCase().includes(needle)
    || (session.resolvedRoot && session.resolvedRoot.toLowerCase().includes(needle))
  ));
  const fuzzyResult = resolveMatchSet(fuzzyMatches, query);
  if (fuzzyResult) return fuzzyResult;

  const normalizedNeedle = normalizeCodeSessionTarget(query);
  if (normalizedNeedle) {
    const normalizedExactMatches = sessions.filter((session) => (
      normalizeCodeSessionTarget(session.id) === normalizedNeedle
      || normalizeCodeSessionTarget(session.title) === normalizedNeedle
      || normalizeCodeSessionTarget(session.workspaceRoot) === normalizedNeedle
      || normalizeCodeSessionTarget(session.resolvedRoot || '') === normalizedNeedle
    ));
    const normalizedExactResult = resolveMatchSet(normalizedExactMatches, query);
    if (normalizedExactResult) return normalizedExactResult;

    const normalizedFuzzyMatches = sessions.filter((session) => (
      normalizeCodeSessionTarget(session.id).includes(normalizedNeedle)
      || normalizeCodeSessionTarget(session.title).includes(normalizedNeedle)
      || normalizeCodeSessionTarget(session.workspaceRoot).includes(normalizedNeedle)
      || normalizeCodeSessionTarget(session.resolvedRoot || '').includes(normalizedNeedle)
    ));
    const normalizedFuzzyResult = resolveMatchSet(normalizedFuzzyMatches, query);
    if (normalizedFuzzyResult) return normalizedFuzzyResult;
  }

  const semanticNeedle = normalizeSemanticCodeSessionTarget(query);
  if (semanticNeedle) {
    const semanticExactMatches = sessions.filter((session) => (
      normalizeSemanticCodeSessionTarget(session.id) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.title) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.workspaceRoot) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.resolvedRoot || '') === semanticNeedle
    ));
    const semanticExactResult = resolveMatchSet(semanticExactMatches, query);
    if (semanticExactResult) return semanticExactResult;

    const semanticFuzzyMatches = sessions.filter((session) => (
      normalizeSemanticCodeSessionTarget(session.id).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.title).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.workspaceRoot).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.resolvedRoot || '').includes(semanticNeedle)
    ));
    const semanticFuzzyResult = resolveMatchSet(semanticFuzzyMatches, query);
    if (semanticFuzzyResult) return semanticFuzzyResult;
  }

  return { error: `No coding session matched "${query}".` };
}

console.log(resolveCodeSessionTarget('Guardian Agent', sessions));
