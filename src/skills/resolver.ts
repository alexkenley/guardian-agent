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
      .map((skill) => ({ skill, score: scoreSkill(skill, input) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (
        b.score - a.score
        || skillRolePriority(b.skill.manifest.role) - skillRolePriority(a.skill.manifest.role)
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

function scoreSkill(skill: LoadedSkill, input: SkillResolutionInput): number {
  const manifest = skill.manifest;
  if (manifest.enabled === false) return 0;

  const appliesTo = manifest.appliesTo;
  if (appliesTo?.agents?.length && !appliesTo.agents.includes(input.agentId)) return 0;
  if (appliesTo?.channels?.length && !appliesTo.channels.includes(input.channel)) return 0;
  if (appliesTo?.requestTypes?.length && !appliesTo.requestTypes.includes(input.requestType)) return 0;

  if (manifest.requiredManagedProvider) {
    const providers = input.enabledManagedProviders ?? new Set<string>();
    if (!providers.has(manifest.requiredManagedProvider)) return 0;
  }

  const lowerContent = input.content.toLowerCase();
  let score = 0;
  const keywords = manifest.triggers?.keywords ?? [];

  if (manifest.tags?.length) {
    for (const tag of manifest.tags) {
      if (lowerContent.includes(tag.toLowerCase())) score += 1;
    }
  }

  for (const keyword of keywords) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      score += 3;
    }
  }

  if (keywords.length === 0) {
    score += scoreExplicitSkillMention(manifest, lowerContent);
    if (score === 0) {
      score += scoreDescriptionFallback(manifest.description, lowerContent);
    }
  }

  if (score === 0 && keywords.length === 0 && manifest.requiredManagedProvider) {
    score = 1;
  }

  return score;
}

function scoreExplicitSkillMention(manifest: LoadedSkill['manifest'], lowerContent: string): number {
  const candidates = new Set<string>();
  const id = manifest.id.trim().toLowerCase();
  if (id) {
    candidates.add(id);
    candidates.add(id.replace(/[-_]+/g, ' '));
  }
  const name = manifest.name.trim().toLowerCase();
  if (name) candidates.add(name);
  for (const candidate of candidates) {
    if (candidate && lowerContent.includes(candidate)) return 6;
  }
  return 0;
}

function scoreDescriptionFallback(description: string, lowerContent: string): number {
  const terms = tokenizeFallbackText(description);
  let matches = 0;
  for (const term of terms) {
    if (lowerContent.includes(term)) matches += 1;
  }
  if (matches >= 3) return 3;
  if (matches >= 2) return 2;
  return 0;
}

function tokenizeFallbackText(text: string): string[] {
  const stopWords = new Set([
    'about', 'after', 'also', 'build', 'create', 'does', 'even', 'from', 'have', 'help',
    'into', 'make', 'more', 'only', 'that', 'their', 'them', 'then', 'they', 'this',
    'tool', 'tools', 'use', 'used', 'using', 'user', 'users', 'when', 'with', 'your',
  ]);
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4 && !stopWords.has(part))
  )];
}
