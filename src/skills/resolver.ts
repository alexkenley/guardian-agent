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
      .sort((a, b) => b.score - a.score || a.skill.manifest.name.localeCompare(b.skill.manifest.name))
      .slice(0, this.maxActivePerRequest);

    return scored.map(({ skill, score }) => ({
      id: skill.manifest.id,
      name: skill.manifest.name,
      summary: skill.summary,
      sourcePath: skill.instructionPath,
      score,
    }));
  }
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

  if (manifest.tags?.length) {
    for (const tag of manifest.tags) {
      if (lowerContent.includes(tag.toLowerCase())) score += 1;
    }
  }

  const keywords = manifest.triggers?.keywords ?? [];
  for (const keyword of keywords) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      score += 3;
    }
  }

  if (score === 0 && keywords.length === 0 && manifest.requiredManagedProvider) {
    score = 1;
  }

  return score;
}
