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
  }

  if (manifest.requiredCapabilities?.length) {
    const capabilities = input.availableCapabilities ?? new Set<string>();
    for (const capability of manifest.requiredCapabilities) {
      if (!capabilities.has(capability)) return { score: 0, specificity: 0 };
    }
  }

  const normalizedContent = normalizeTriggerText(input.content);
  let score = 0;
  let specificity = 0;
  const keywords = manifest.triggers?.keywords ?? [];

  if (manifest.tags?.length) {
    for (const tag of manifest.tags) {
      if (containsNormalizedPhrase(normalizedContent, tag)) {
        score += 1;
        specificity += phraseSpecificity(tag);
      }
    }
  }

  const explicitMention = scoreExplicitSkillMention(manifest, normalizedContent);
  score += explicitMention.score;
  specificity += explicitMention.specificity;

  const keywordMatches = scoreKeywordMatches(keywords, normalizedContent);
  score += keywordMatches.score;
  specificity += keywordMatches.specificity;

  const descriptionMatches = scoreDescriptionFallback(manifest.description, normalizedContent);
  score += descriptionMatches.score;
  specificity += descriptionMatches.specificity;

  if (isReviewedImportManifest(manifest) && explicitMention.score === 0) {
    const strongKeywordSignal = keywordMatches.matchCount >= 2 || keywordMatches.hasMultiWordMatch;
    const combinedSignal = keywordMatches.matchCount >= 1 && descriptionMatches.matchCount >= 2;
    const providerSignal = !!manifest.requiredManagedProvider
      && (keywordMatches.matchCount >= 1 || descriptionMatches.matchCount >= 1);
    if (!(strongKeywordSignal || combinedSignal || providerSignal)) {
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
