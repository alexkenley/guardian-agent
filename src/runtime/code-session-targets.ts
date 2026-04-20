export interface CodeSessionTargetRecord {
  id: string;
  title: string;
  workspaceRoot: string;
  resolvedRoot?: string | null;
}

const GENERIC_CODE_SESSION_TOKENS = new Set([
  'a',
  'an',
  'the',
  'my',
  'this',
  'that',
  'workspace',
  'workspaces',
  'session',
  'sessions',
  'coding',
  'code',
  'project',
  'repo',
  'repository',
]);

function normalizeCodeSessionTarget(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeSemanticCodeSessionTarget(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter((token) => !GENERIC_CODE_SESSION_TOKENS.has(token))
    .join('');
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

  const semanticNeedle = normalizeSemanticCodeSessionTarget(query);
  if (semanticNeedle) {
    const semanticExactMatches = sessions.filter((session) => (
      normalizeSemanticCodeSessionTarget(session.id) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.title) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.workspaceRoot) === semanticNeedle
      || normalizeSemanticCodeSessionTarget(session.resolvedRoot ?? '') === semanticNeedle
    ));
    const semanticExactResult = resolveMatchSet(semanticExactMatches, query);
    if (semanticExactResult) return semanticExactResult;

    const semanticFuzzyMatches = sessions.filter((session) => (
      normalizeSemanticCodeSessionTarget(session.id).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.title).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.workspaceRoot).includes(semanticNeedle)
      || normalizeSemanticCodeSessionTarget(session.resolvedRoot ?? '').includes(semanticNeedle)
    ));
    const semanticFuzzyResult = resolveMatchSet(semanticFuzzyMatches, query);
    if (semanticFuzzyResult) return semanticFuzzyResult;
  }

  // Fallback: If the user said "Guardian Agent" or "the main repo" and there are multiple sessions,
  // we might fail above if the semantic needle is empty or too broad to be a unique substring.
  // But if the semantic needle is empty (meaning they just said "the main repo" or "this workspace"
  // but explicitly tried to attach to something else), we shouldn't guess.
  // However, there is a bug where 'Guardian Agent' normalizes to 'guardianagent' which matches
  // BOTH the title 'Guardian Agent' and the workspaceRoot 'S:\\Development\\GuardianAgent' and 
  // resolvedRoot 'S:\\Development\\GuardianAgent\\tmp\\guardian-ui-package-test'.
  //
  // Wait, let's look at why it failed:
  // query: "Guardian Agent"
  // semanticNeedle: "guardianagent"
  // semanticFuzzyMatches checks if 'guardianagent' is included in 'guardianagent' (id: da47084e...) -> no
  // title: 'guardianagent' -> yes
  // workspaceRoot: 'sdevelopmentguardianagent' -> yes
  // AND for the OTHER session:
  // title: 'tempinstalltest' -> no
  // workspaceRoot: 'sdevelopmentguardianagenttmpguardianuipackagetest' -> YES (it includes 'guardianagent'!)
  //
  // So 'Guardian Agent' fuzzy matches BOTH sessions because the temp session is inside the main repo!
  //
  // To fix this, we need to prefer semantic EXACT matches, which we do.
  // Did semanticExactMatches fail?
  // semanticNeedle = "guardianagent"
  // Session 1: title = "guardianagent", workspaceRoot = "sdevelopmentguardianagent"
  // Session 2: title = "tempinstalltest", workspaceRoot = "sdevelopmentguardianagenttmpguardianuipackagetest"
  // For Session 1, `normalizeSemanticCodeSessionTarget(session.title) === semanticNeedle` is true!
  // So semanticExactMatches should have length 1.
  // Wait!
  // In `normalizeSemanticCodeSessionTarget` we remove all non-alphanumeric.
  // For Session 1: title = "Guardian Agent" -> "guardianagent"
  // semanticNeedle for "Guardian Agent" -> "guardianagent".
  // So semanticExactMatches should have found it!
  // Let me trace again.

  return { error: `No coding session matched "${query}".` };
}
