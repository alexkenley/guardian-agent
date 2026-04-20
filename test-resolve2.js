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

const query = 'Guardian Agent coding workspace';
const normalizedNeedle = normalizeCodeSessionTarget(query);
console.log('normalizedNeedle:', normalizedNeedle);
const normalizedExactMatches = sessions.filter((session) => (
  normalizeCodeSessionTarget(session.id) === normalizedNeedle
  || normalizeCodeSessionTarget(session.title) === normalizedNeedle
  || normalizeCodeSessionTarget(session.workspaceRoot) === normalizedNeedle
  || normalizeCodeSessionTarget(session.resolvedRoot || '') === normalizedNeedle
));
console.log('normalizedExactMatches length:', normalizedExactMatches.length);

const normalizedFuzzyMatches = sessions.filter((session) => (
  normalizeCodeSessionTarget(session.id).includes(normalizedNeedle)
  || normalizeCodeSessionTarget(session.title).includes(normalizedNeedle)
  || normalizeCodeSessionTarget(session.workspaceRoot).includes(normalizedNeedle)
  || normalizeCodeSessionTarget(session.resolvedRoot || '').includes(normalizedNeedle)
));
console.log('normalizedFuzzyMatches length:', normalizedFuzzyMatches.length);


const semanticNeedle = normalizeSemanticCodeSessionTarget(query);
console.log('semanticNeedle:', semanticNeedle);
const semanticExactMatches = sessions.filter((session) => (
  normalizeSemanticCodeSessionTarget(session.id) === semanticNeedle
  || normalizeSemanticCodeSessionTarget(session.title) === semanticNeedle
  || normalizeSemanticCodeSessionTarget(session.workspaceRoot) === semanticNeedle
  || normalizeSemanticCodeSessionTarget(session.resolvedRoot || '') === semanticNeedle
));
console.log('semanticExactMatches length:', semanticExactMatches.length);

const semanticFuzzyMatches = sessions.filter((session) => (
  normalizeSemanticCodeSessionTarget(session.id).includes(semanticNeedle)
  || normalizeSemanticCodeSessionTarget(session.title).includes(semanticNeedle)
  || normalizeSemanticCodeSessionTarget(session.workspaceRoot).includes(semanticNeedle)
  || normalizeSemanticCodeSessionTarget(session.resolvedRoot || '').includes(semanticNeedle)
));
console.log('semanticFuzzyMatches length:', semanticFuzzyMatches.length);
