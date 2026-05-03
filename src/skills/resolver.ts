import type { LoadedSkill, ResolvedSkill, SkillResolutionInput } from './types.js';
import { SkillRegistry } from './registry.js';

export interface SkillResolverOptions {
  autoSelect?: boolean;
  maxActivePerRequest?: number;
}

export class SkillResolver {
  private readonly registry: SkillRegistry;
  private readonly autoSelect: boolean;
  private readonly maxActivePerRequest: number;

  constructor(registry: SkillRegistry, options: SkillResolverOptions = {}) {
    this.registry = registry;
    this.autoSelect = options.autoSelect !== false;
    this.maxActivePerRequest = Math.max(1, options.maxActivePerRequest ?? 3);
  }

  resolve(input: SkillResolutionInput): ResolvedSkill[] {
    if (!this.autoSelect) return [];

    const scored = this.registry.list()
      .map((skill) => ({ skill, ...scoreSkill(skill, input) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (
        b.score - a.score
        || b.specificity - a.specificity
        || skillRolePriority(b.skill.manifest.role) - skillRolePriority(a.skill.manifest.role)
        || skillSourcePriority(b.skill) - skillSourcePriority(a.skill)
        || a.skill.manifest.name.localeCompare(b.skill.manifest.name)
      ))
      .slice(0, this.maxActivePerRequest);

    return scored.map(({ skill, score }) => ({
      id: skill.manifest.id,
      name: skill.manifest.name,
      description: skill.manifest.description,
      role: skill.manifest.role,
      summary: skill.summary,
      sourcePath: skill.instructionPath,
      score,
    }));
  }
}

const ROUTE_SKILL_BONUSES: Partial<Record<string, { process?: number; domain?: number }>> = {
  automation_authoring: { process: 5, domain: 1 },
  automation_control: { process: 4, domain: 1 },
  automation_output_task: { process: 1, domain: 2 },
  browser_task: { domain: 3 },
  personal_assistant_task: { process: 2, domain: 4 },
  workspace_task: { domain: 3 },
  email_task: { domain: 4 },
  search_task: { domain: 4 },
  memory_task: { domain: 3 },
  filesystem_task: { domain: 2 },
  coding_task: { process: 4, domain: 3 },
  coding_session_control: { domain: 2 },
  security_task: { process: 2, domain: 5 },
};

const ROUTE_TRIGGER_KEYWORDS: Partial<Record<string, string[]>> = {
  automation_authoring: ['automation', 'workflow', 'schedule', 'cron'],
  automation_control: ['automation', 'workflow', 'schedule', 'cron'],
  automation_output_task: ['automation output', 'run output', 'previous run'],
  browser_task: ['browser', 'web page', 'website'],
  personal_assistant_task: ['second brain', 'tasks', 'notes', 'calendar', 'meeting prep', 'routine', 'brief'],
  workspace_task: ['calendar', 'drive', 'docs', 'sheets', 'contacts', 'workspace'],
  email_task: ['email', 'gmail', 'outlook', 'mail'],
  search_task: ['search', 'research', 'documentation', 'docs', 'wiki'],
  memory_task: ['memory', 'remember', 'recall'],
  filesystem_task: ['file', 'filesystem', 'path', 'directory'],
  coding_task: ['code', 'repo', 'bug', 'debug', 'patch', 'refactor', 'test'],
  coding_session_control: ['coding session', 'workspace'],
  security_task: ['security', 'incident', 'alert', 'threat', 'firewall'],
};

const CLARIFICATION_TURN_RELATIONS = new Set(['clarification_answer', 'correction']);

const STICKY_PENDING_ACTION_KINDS = new Set(['approval', 'clarification', 'workspace_switch']);

const PROVIDER_ENTITY_HINTS: Record<string, string[]> = {
  gws: ['gmail', 'google workspace', 'calendar', 'drive', 'docs', 'sheets', 'contacts'],
  m365: ['outlook', 'microsoft 365', 'm365', 'onedrive', 'calendar', 'contacts'],
};

const CODING_BACKEND_HINTS: Record<string, string[]> = {
  codex: ['codex'],
  'claude-code': ['claude code'],
  'gemini-cli': ['gemini', 'gemini cli'],
  aider: ['aider'],
};

const UI_SURFACE_HINTS: Record<string, string[]> = {
  automations: ['automation', 'workflow', 'schedule'],
  system: ['system', 'status'],
  dashboard: ['dashboard'],
  config: ['config', 'configuration', 'settings'],
  chat: ['chat'],
};

const TOOL_NAME_HINTS: Record<string, string[]> = {
  web_search: ['search', 'research', 'current information'],
  web_fetch: ['article', 'url', 'page', 'documentation'],
  doc_search: ['docs', 'documentation', 'wiki', 'knowledge base'],
  gws: ['gmail', 'google workspace', 'calendar', 'drive', 'docs', 'sheets'],
  m365: ['outlook', 'microsoft 365', 'm365', 'onedrive'],
  outlook_draft: ['outlook', 'draft'],
  outlook_send: ['outlook', 'send'],
  automation_save: ['automation', 'workflow', 'schedule'],
  workflow_upsert: ['automation', 'workflow'],
  task_create: ['automation', 'schedule'],
  code_plan: ['code', 'plan', 'implementation'],
  code_git_diff: ['diff', 'patch', 'pr'],
  code_test: ['test', 'failing test'],
  code_lint: ['lint'],
};

const PROFILE_HINTS: Record<string, string[]> = {
  social: ['social'],
};

const MEMORY_KEYWORD_SKILL_IDS = new Set(['knowledge-search', 'preferences-memory']);

const TOOL_CATEGORY_HINTS: Record<string, string[]> = {
  automation: ['automation', 'workflow', 'schedule'],
  browser: ['browser', 'website', 'web page'],
  email: ['email', 'gmail', 'outlook', 'mail'],
  search: ['search', 'research', 'documentation', 'wiki'],
  security: ['security', 'incident', 'alert', 'threat'],
  coding: ['code', 'repo', 'patch', 'bug', 'test'],
};

const REPO_PATH_HINT_PATTERN = /\b(?:src|web|docs|scripts|skills|policies|native|test|tests|dist|package\.json|tsconfig(?:\.[a-z0-9_-]+)?\.json)(?:[\\/][^\s:;,)\]}]+)?/i;
const STRONG_REPO_PATH_HINT_PATTERN = /\b(?:(?:src|web|docs|scripts|skills|policies|native|test|tests|dist)[\\/][^\s:;,)\]}]+|package\.json|tsconfig(?:\.[a-z0-9_-]+)?\.json)\b/i;
const CODE_FILE_HINT_PATTERN = /\b[^\s:;,)\]}]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|rs|py|sh|html|css|scss)\b/i;
const FILE_GROUNDED_CODING_ACTION_PATTERN = /\b(review|regressions?|missing tests?|implementation plan|inspect|explain|patch|diff|pull request|pr|refactor|bugfix)\b/i;
const LOCAL_WORKSPACE_CONTEXT_PATTERN = /\b(?:repo|repository|codebase|source code|local code|this workspace|current workspace|workspace\/repo|workspace files?)\b/i;
const STATUS_ONLY_REQUEST_PATTERN = /\b(status|connected|connection|authenticated|auth|health|sync health|enabled|scopes|configured)\b/i;
const CAMPAIGN_ACTION_PATTERN = /\b(campaign|outreach|bulk[-\s]?email|mailing[-\s]?list|import contacts|send campaign|dry run)\b/i;
const MANAGED_PROVIDER_STATUS_TARGET_PATTERN = /\b(google workspace|microsoft 365|m365|gmail|outlook|drive|onedrive|calendar|contacts)\b/i;

function bonusForRole(route: string | undefined, role: LoadedSkill['manifest']['role']): number {
  if (!route) return 0;
  const routeBonus = ROUTE_SKILL_BONUSES[route];
  if (!routeBonus) return 0;
  return role === 'process' ? (routeBonus.process ?? 0) : (routeBonus.domain ?? 0);
}

function hasAnyMatch(normalizedContent: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => containsNormalizedPhrase(normalizedContent, candidate));
}

function normalizeManagedProviderEntity(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'gws' || normalized === 'm365') {
    return normalized;
  }
  return null;
}

function explicitlyTargetsManagedProvider(
  input: SkillResolutionInput,
  provider: string,
): boolean {
  const emailProvider = normalizeManagedProviderEntity(input.intentEntities?.emailProvider);
  if (emailProvider === provider) return true;
  const calendarTarget = normalizeManagedProviderEntity(input.intentEntities?.calendarTarget);
  return calendarTarget === provider;
}

function shouldAllowManagedProviderSkill(
  manifest: LoadedSkill['manifest'],
  input: SkillResolutionInput,
): boolean {
  const provider = normalizeManagedProviderEntity(manifest.requiredManagedProvider);
  if (!provider) return true;
  if (input.intentRoute !== 'personal_assistant_task') return true;
  return explicitlyTargetsManagedProvider(input, provider);
}

function scoreIntentEntityMatches(
  manifest: LoadedSkill['manifest'],
  input: SkillResolutionInput,
  normalizedContent: string,
): { score: number; specificity: number } {
  const entities = input.intentEntities;
  if (!entities) return { score: 0, specificity: 0 };

  let score = 0;
  let specificity = 0;

  const emailProvider = entities.emailProvider?.trim().toLowerCase();
  if (emailProvider && hasAnyMatch(normalizedContent, PROVIDER_ENTITY_HINTS[emailProvider] ?? [])) {
    score += 2;
    specificity += 4;
  }

  const calendarTarget = normalizeManagedProviderEntity(entities.calendarTarget);
  if (calendarTarget && hasAnyMatch(normalizedContent, PROVIDER_ENTITY_HINTS[calendarTarget] ?? [])) {
    score += 2;
    specificity += 4;
  }

  const codingBackend = entities.codingBackend?.trim().toLowerCase();
  if (codingBackend && hasAnyMatch(normalizedContent, CODING_BACKEND_HINTS[codingBackend] ?? [])) {
    score += 2;
    specificity += 4;
  }

  const uiSurface = entities.uiSurface?.trim().toLowerCase();
  if (uiSurface && hasAnyMatch(normalizedContent, UI_SURFACE_HINTS[uiSurface] ?? [])) {
    score += 1;
    specificity += 2;
  }

  const toolName = entities.toolName?.trim();
  if (toolName && hasAnyMatch(normalizedContent, TOOL_NAME_HINTS[toolName] ?? [])) {
    score += 1;
    specificity += 2;
  }

  const profileId = entities.profileId?.trim().toLowerCase();
  if (profileId && hasAnyMatch(normalizedContent, PROFILE_HINTS[profileId] ?? [])) {
    score += 1;
    specificity += 1;
  }

  for (const keyword of manifest.triggers?.keywords ?? []) {
    if (!containsNormalizedPhrase(normalizedContent, keyword)) continue;
    if (emailProvider && hasAnyMatch(normalizeTriggerText(keyword), PROVIDER_ENTITY_HINTS[emailProvider] ?? [])) {
      score += 2;
      specificity += phraseSpecificity(keyword);
    }
    if (calendarTarget && hasAnyMatch(normalizeTriggerText(keyword), PROVIDER_ENTITY_HINTS[calendarTarget] ?? [])) {
      score += 2;
      specificity += phraseSpecificity(keyword);
    }
    if (codingBackend && hasAnyMatch(normalizeTriggerText(keyword), CODING_BACKEND_HINTS[codingBackend] ?? [])) {
      score += 2;
      specificity += phraseSpecificity(keyword);
    }
    if (toolName && hasAnyMatch(normalizeTriggerText(keyword), TOOL_NAME_HINTS[toolName] ?? [])) {
      score += 1;
      specificity += phraseSpecificity(keyword);
    }
  }

  return { score, specificity };
}

function scoreRouteMatches(
  skill: LoadedSkill,
  input: SkillResolutionInput,
  normalizedContent: string,
): { score: number; specificity: number } {
  const route = input.intentRoute;
  if (!route) return { score: 0, specificity: 0 };

  let score = bonusForRole(route, skill.manifest.role);
  let specificity = score > 0 ? score * 2 : 0;

  if (hasAnyMatch(normalizedContent, ROUTE_TRIGGER_KEYWORDS[route] ?? [])) {
    score += 1;
    specificity += 3;
  }

  if (route === 'memory_task' && MEMORY_KEYWORD_SKILL_IDS.has(skill.manifest.id)) {
    score += 2;
    specificity += 4;
  }

  if (route === 'coding_task' && skill.manifest.tools?.some((tool) => tool.startsWith('code_'))) {
    score += 1;
    specificity += 2;
  }

  if (
    route === 'coding_task'
    && input.intentEntities?.codingBackend?.trim()
    && skill.manifest.tools?.some((tool) => tool === 'coding_backend_run' || tool === 'coding_backend_status')
  ) {
    score += 3;
    specificity += 6;
  }

  if ((route === 'email_task' || route === 'workspace_task') && skill.manifest.requiredManagedProvider) {
    score += 1;
    specificity += 2;
  }

  if (route === 'search_task' && skill.manifest.tools?.some((tool) => tool === 'web_search' || tool === 'doc_search')) {
    score += 1;
    specificity += 2;
  }

  return { score, specificity };
}

function scoreContinuityAndPendingAction(
  skill: LoadedSkill,
  input: SkillResolutionInput,
): { score: number; specificity: number } {
  let score = 0;
  let specificity = 0;

  const priorActiveSkills = new Set((input.priorActiveSkillIds ?? []).map((value) => value.trim()).filter(Boolean));
  if (priorActiveSkills.has(skill.manifest.id)) {
    if (CLARIFICATION_TURN_RELATIONS.has(input.intentTurnRelation ?? '')) {
      score += 3;
      specificity += 6;
    }
    if (input.pendingActionKind && STICKY_PENDING_ACTION_KINDS.has(input.pendingActionKind)) {
      score += 2;
      specificity += 4;
    }
  }

  return { score, specificity };
}

function scoreToolSignals(
  skill: LoadedSkill,
  input: SkillResolutionInput,
): { score: number; specificity: number } {
  const route = input.intentRoute;
  if (!route) return { score: 0, specificity: 0 };
  const toolHints = ROUTE_TRIGGER_KEYWORDS[route] ?? [];
  if (toolHints.length === 0) return { score: 0, specificity: 0 };

  let score = 0;
  let specificity = 0;
  for (const tool of skill.manifest.tools ?? []) {
    const hints = TOOL_NAME_HINTS[tool] ?? TOOL_CATEGORY_HINTS[tool] ?? [];
    if (hints.length === 0) continue;
    for (const hint of hints) {
      if (!hasAnyMatch(normalizeTriggerText(hint), toolHints)) continue;
      score += 1;
      specificity += phraseSpecificity(hint);
      break;
    }
  }
  return { score, specificity };
}

function scoreContextHints(
  manifest: LoadedSkill['manifest'],
  input: SkillResolutionInput,
): { score: number; specificity: number } {
  let score = 0;
  let specificity = 0;

  const focusContent = [input.continuityFocusSummary, input.continuityLastActionableRequest]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
  if (!focusContent) return { score: 0, specificity: 0 };
  const normalizedFocus = normalizeTriggerText(focusContent);

  for (const tag of manifest.tags ?? []) {
    if (containsNormalizedPhrase(normalizedFocus, tag)) {
      score += 1;
      specificity += phraseSpecificity(tag);
    }
  }

  for (const keyword of manifest.triggers?.keywords ?? []) {
    if (containsNormalizedPhrase(normalizedFocus, keyword)) {
      score += 1;
      specificity += phraseSpecificity(keyword);
    }
  }

  return { score, specificity };
}

function scoreRepoGroundingHints(
  skill: LoadedSkill,
  input: SkillResolutionInput,
): { score: number; specificity: number } {
  if (skill.manifest.id !== 'coding-workspace') {
    return { score: 0, specificity: 0 };
  }

  let score = 0;
  let specificity = 0;
  const hasRepoPathHint = REPO_PATH_HINT_PATTERN.test(input.content) || CODE_FILE_HINT_PATTERN.test(input.content);
  const routeAllowsCodeSessionHint = input.intentRoute === 'coding_task' || input.intentRoute === 'coding_session_control';
  if (input.codeSessionAttached && routeAllowsCodeSessionHint) {
    score += 2;
    specificity += 4;
  }
  if (input.hasTaggedFileContext) {
    score += 1;
    specificity += 3;
  }
  if (hasRepoPathHint) {
    score += 1;
    specificity += 3;
  }
  if (hasRepoPathHint && FILE_GROUNDED_CODING_ACTION_PATTERN.test(input.content)) {
    score += 1;
    specificity += 3;
  }
  return { score, specificity };
}

function shouldSuppressForClarification(input: SkillResolutionInput): boolean {
  return input.intentResolution === 'needs_clarification' && !CLARIFICATION_TURN_RELATIONS.has(input.intentTurnRelation ?? '');
}

function shouldSuppressForStatusOnlyRequest(
  manifest: LoadedSkill['manifest'],
  normalizedContent: string,
  explicitMentionScore: number,
): boolean {
  if (manifest.requiredManagedProvider) return false;
  if (manifest.risk !== 'operational') return false;
  if (explicitMentionScore > 0) return false;
  const campaignOrOutreachSkill = [...(manifest.tags ?? []), ...(manifest.triggers?.keywords ?? [])]
    .some((value) => CAMPAIGN_ACTION_PATTERN.test(value));
  if (!campaignOrOutreachSkill) return false;
  if (CAMPAIGN_ACTION_PATTERN.test(normalizedContent)) return false;
  return STATUS_ONLY_REQUEST_PATTERN.test(normalizedContent);
}

function shouldSuppressCodingWorkspaceForProviderStatus(
  manifest: LoadedSkill['manifest'],
  content: string,
  normalizedContent: string,
  explicitMentionScore: number,
): boolean {
  if (manifest.id !== 'coding-workspace') return false;
  if (explicitMentionScore > 0) return false;
  if (!STATUS_ONLY_REQUEST_PATTERN.test(normalizedContent)) return false;
  if (!MANAGED_PROVIDER_STATUS_TARGET_PATTERN.test(normalizedContent)) return false;
  const hasRepoPathHint = STRONG_REPO_PATH_HINT_PATTERN.test(content)
    || CODE_FILE_HINT_PATTERN.test(content)
    || LOCAL_WORKSPACE_CONTEXT_PATTERN.test(normalizedContent);
  return !hasRepoPathHint && !FILE_GROUNDED_CODING_ACTION_PATTERN.test(content);
}

function shouldKeepSkillForAmbiguousClarification(skill: LoadedSkill, input: SkillResolutionInput): boolean {
  const priorActiveSkills = new Set((input.priorActiveSkillIds ?? []).map((value) => value.trim()).filter(Boolean));
  return priorActiveSkills.has(skill.manifest.id);
}

function skillRolePriority(role: LoadedSkill['manifest']['role']): number {
  return role === 'process' ? 1 : 0;
}

function skillSourcePriority(skill: LoadedSkill): number {
  return isReviewedImportManifest(skill.manifest) ? 0 : 1;
}

function scoreSkill(skill: LoadedSkill, input: SkillResolutionInput): { score: number; specificity: number } {
  const manifest = skill.manifest;

  const appliesTo = manifest.appliesTo;
  if (appliesTo?.agents?.length && !appliesTo.agents.includes(input.agentId)) return { score: 0, specificity: 0 };
  if (appliesTo?.channels?.length && !appliesTo.channels.includes(input.channel)) return { score: 0, specificity: 0 };
  if (appliesTo?.requestTypes?.length && !appliesTo.requestTypes.includes(input.requestType)) return { score: 0, specificity: 0 };

  if (manifest.requiredManagedProvider) {
    const providers = input.enabledManagedProviders ?? new Set<string>();
    if (!providers.has(manifest.requiredManagedProvider)) return { score: 0, specificity: 0 };
    if (!shouldAllowManagedProviderSkill(manifest, input)) return { score: 0, specificity: 0 };
  }

  if (manifest.requiredCapabilities?.length) {
    const capabilities = input.availableCapabilities ?? new Set<string>();
    for (const capability of manifest.requiredCapabilities) {
      if (!capabilities.has(capability)) return { score: 0, specificity: 0 };
    }
  }

  if (shouldSuppressForClarification(input) && !shouldKeepSkillForAmbiguousClarification(skill, input)) {
    return { score: 0, specificity: 0 };
  }

  const normalizedContent = normalizeTriggerText(input.content);
  let score = 0;
  let specificity = 0;
  const keywords = manifest.triggers?.keywords ?? [];
  const explicitMention = scoreExplicitSkillMention(manifest, normalizedContent);

  if (shouldSuppressCodingWorkspaceForProviderStatus(manifest, input.content, normalizedContent, explicitMention.score)) {
    return { score: 0, specificity: 0 };
  }

  if (manifest.tags?.length) {
    for (const tag of manifest.tags) {
      if (containsNormalizedPhrase(normalizedContent, tag)) {
        score += 1;
        specificity += phraseSpecificity(tag);
      }
    }
  }

  if (shouldSuppressForStatusOnlyRequest(manifest, normalizedContent, explicitMention.score)) {
    return { score: 0, specificity: 0 };
  }
  score += explicitMention.score;
  specificity += explicitMention.specificity;

  const keywordMatches = scoreKeywordMatches(keywords, normalizedContent);
  score += keywordMatches.score;
  specificity += keywordMatches.specificity;

  const descriptionMatches = scoreDescriptionFallback(manifest.description, normalizedContent);
  score += descriptionMatches.score;
  specificity += descriptionMatches.specificity;

  const routeMatches = scoreRouteMatches(skill, input, normalizedContent);
  score += routeMatches.score;
  specificity += routeMatches.specificity;

  const intentEntityMatches = scoreIntentEntityMatches(manifest, input, normalizedContent);
  score += intentEntityMatches.score;
  specificity += intentEntityMatches.specificity;

  const continuityAndPendingAction = scoreContinuityAndPendingAction(skill, input);
  score += continuityAndPendingAction.score;
  specificity += continuityAndPendingAction.specificity;

  const contextHints = scoreContextHints(manifest, input);
  score += contextHints.score;
  specificity += contextHints.specificity;

  const repoGroundingHints = scoreRepoGroundingHints(skill, input);
  score += repoGroundingHints.score;
  specificity += repoGroundingHints.specificity;

  const toolSignals = scoreToolSignals(skill, input);
  score += toolSignals.score;
  specificity += toolSignals.specificity;

  if (isReviewedImportManifest(manifest) && explicitMention.score === 0) {
    const strongKeywordSignal = keywordMatches.matchCount >= 2 || keywordMatches.hasMultiWordMatch;
    const combinedSignal = keywordMatches.matchCount >= 1 && descriptionMatches.matchCount >= 2;
    const providerSignal = !!manifest.requiredManagedProvider
      && (keywordMatches.matchCount >= 1 || descriptionMatches.matchCount >= 1);
    const structuredSignal = routeMatches.score > 0 || intentEntityMatches.score > 0;
    if (!(strongKeywordSignal || combinedSignal || providerSignal || structuredSignal)) {
      return { score: 0, specificity: 0 };
    }
    score = Math.max(1, score - 1);
  }

  if (score === 0 && keywords.length === 0 && manifest.requiredManagedProvider) {
    score = 1;
  }

  return { score, specificity };
}

function scoreExplicitSkillMention(
  manifest: LoadedSkill['manifest'],
  normalizedContent: string,
): { score: number; specificity: number } {
  const candidates = new Set<string>();
  const id = manifest.id.trim().toLowerCase();
  if (id) {
    candidates.add(id);
    candidates.add(id.replace(/[-_]+/g, ' '));
  }
  const name = manifest.name.trim().toLowerCase();
  if (name) candidates.add(name);
  for (const candidate of candidates) {
    if (containsNormalizedPhrase(normalizedContent, candidate)) {
      return {
        score: 6,
        specificity: phraseSpecificity(candidate) + 4,
      };
    }
  }
  return { score: 0, specificity: 0 };
}

function scoreKeywordMatches(
  keywords: readonly string[],
  normalizedContent: string,
): { score: number; specificity: number; matchCount: number; hasMultiWordMatch: boolean } {
  let score = 0;
  let specificity = 0;
  let matchCount = 0;
  let hasMultiWordMatch = false;
  for (const keyword of keywords) {
    if (!containsNormalizedPhrase(normalizedContent, keyword)) continue;
    matchCount += 1;
    hasMultiWordMatch = hasMultiWordMatch || countPhraseWords(keyword) > 1;
    score += 3 + keywordSpecificityBonus(keyword);
    specificity += phraseSpecificity(keyword);
  }
  return { score, specificity, matchCount, hasMultiWordMatch };
}

function scoreDescriptionFallback(
  description: string,
  normalizedContent: string,
): { score: number; specificity: number; matchCount: number } {
  const terms = tokenizeFallbackText(description);
  let matches = 0;
  let specificity = 0;
  for (const term of terms) {
    if (containsNormalizedPhrase(normalizedContent, term)) {
      matches += 1;
      specificity += phraseSpecificity(term);
    }
  }
  if (matches >= 3) return { score: 3, specificity, matchCount: matches };
  if (matches >= 2) return { score: 2, specificity, matchCount: matches };
  return { score: 0, specificity: 0, matchCount: matches };
}

function tokenizeFallbackText(text: string): string[] {
  const stopWords = new Set([
    'about', 'after', 'also', 'build', 'create', 'does', 'even', 'from', 'have', 'help',
    'into', 'make', 'more', 'only', 'that', 'their', 'them', 'then', 'they', 'this',
    'tool', 'tools', 'use', 'used', 'using', 'user', 'users', 'when', 'with', 'your',
  ]);
  return [...new Set(
    normalizeTriggerText(text)
      .split(/\s+/g)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4 && !stopWords.has(part))
  )];
}

function containsNormalizedPhrase(normalizedContent: string, candidate: string): boolean {
  const normalizedCandidate = normalizeTriggerText(candidate).trim();
  if (!normalizedCandidate) return false;
  return normalizedContent.includes(` ${normalizedCandidate} `);
}

function normalizeTriggerText(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized ? ` ${normalized} ` : ' ';
}

function phraseSpecificity(text: string): number {
  const normalized = normalizeTriggerText(text).trim();
  if (!normalized) return 0;
  return normalized.split(/\s+/g).reduce((total, part) => total + Math.max(1, Math.min(3, part.length - 2)), 0);
}

function keywordSpecificityBonus(keyword: string): number {
  const normalized = normalizeTriggerText(keyword).trim();
  if (!normalized) return 0;
  const words = normalized.split(/\s+/g);
  return Math.max(0, Math.min(2, words.length - 1));
}

function countPhraseWords(text: string): number {
  const normalized = normalizeTriggerText(text).trim();
  if (!normalized) return 0;
  return normalized.split(/\s+/g).length;
}

function isReviewedImportManifest(manifest: LoadedSkill['manifest']): boolean {
  return !!manifest._upstream?.source;
}
