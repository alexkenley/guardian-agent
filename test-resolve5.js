const GENERIC_CODE_SESSION_TOKENS = new Set([
  'a', 'an', 'the', 'my', 'this', 'that', 'workspace', 'workspaces', 'session', 'sessions', 'coding', 'code', 'project', 'repo', 'repository', 'main',
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
    // BUG FIX: if multiple fuzzy matches, see if one exactly matches the needle
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
  // Let's modify resolveMatchSet logic here.
  if (fuzzyMatches.length === 1) return { session: fuzzyMatches[0] };

  const normalizedNeedle = normalizeCodeSessionTarget(query);
  if (normalizedNeedle) {
    const normalizedExactMatches = sessions.filter((session) => (
      normalizeCodeSessionTarget(session.id) === normalizedNeedle
      || normalizeCodeSessionTarget(session.title) === normalizedNeedle
      || normalizeCodeSessionTarget(session.workspaceRoot) === normalizedNeedle
      || normalizeCodeSessionTarget(session.resolvedRoot || '') === normalizedNeedle
    ));
    if (normalizedExactMatches.length === 1) return { session: normalizedExactMatches[0] };

    const normalizedFuzzyMatches = sessions.filter((session) => (
      normalizeCodeSessionTarget(session.id).includes(normalizedNeedle)
      || normalizeCodeSessionTarget(session.title).includes(normalizedNeedle)
      || normalizeCodeSessionTarget(session.workspaceRoot).includes(normalizedNeedle)
      || normalizeCodeSessionTarget(session.resolvedRoot || '').includes(normalizedNeedle)
    ));
    if (normalizedFuzzyMatches.length === 1) return { session: normalizedFuzzyMatches[0] };
  }

  const semanticNeedle = normalizeSemanticCodeSessionTarget(query);
  if (semanticNeedle) {
    const semanticExactMatches = sessions.filter((session) => (
      normalizeSemanticCodeSessionTarget(session.id) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.title) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.workspaceRoot) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.resolvedRoot || '') === semanticNeedle
    ));
    if (semanticExactMatches.length === 1) return { session: semanticExactMatches[0] };

    const semanticFuzzyMatches = sessions.filter((session) => (
      normalizeSemanticCodeSessionTarget(session.id).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.title).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.workspaceRoot).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.resolvedRoot || '').includes(semanticNeedle)
    ));
    
    // HEURISTIC: if multiple fuzzy matches, but one matches exactly on title, use it!
    if (semanticFuzzyMatches.length > 1) {
       const exactTitleMatches = semanticFuzzyMatches.filter(s => normalizeSemanticCodeSessionTarget(s.title) === semanticNeedle);
       if (exactTitleMatches.length === 1) return { session: exactTitleMatches[0] };
       
       // Fallback for paths: if one workspace is the parent of another, and we matched on the parent name, prefer the parent.
       const exactRootMatches = semanticFuzzyMatches.filter(s => normalizeSemanticCodeSessionTarget(s.workspaceRoot).endsWith(semanticNeedle));
       if (exactRootMatches.length === 1) return { session: exactRootMatches[0] };
       
       return { error: `More than one coding session matches "${query}". Use a more specific id or path.` };
    }
    
    if (semanticFuzzyMatches.length === 1) return { session: semanticFuzzyMatches[0] };
  }

  return { error: `No coding session matched "${query}".` };
}

console.log(resolveCodeSessionTarget('main GuardianAgent repo', sessions));
