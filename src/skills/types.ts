export type SkillRisk = 'informational' | 'operational';

export interface SkillAppliesTo {
  agents?: string[];
  channels?: string[];
  requestTypes?: string[];
}

export interface SkillTriggers {
  keywords?: string[];
  intents?: string[];
  toolCategories?: string[];
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  tags?: string[];
  enabled?: boolean;
  appliesTo?: SkillAppliesTo;
  triggers?: SkillTriggers;
  tools?: string[];
  requiredCapabilities?: string[];
  requiredManagedProvider?: string;
  risk?: SkillRisk;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  rootDir: string;
  instructionPath: string;
  instruction: string;
  summary: string;
}

export interface SkillStatus {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  enabled: boolean;
  rootDir: string;
  sourcePath: string;
  risk: SkillRisk;
  tools: string[];
  requiredCapabilities: string[];
  requiredManagedProvider?: string;
}

export interface SkillResolutionInput {
  agentId: string;
  channel: string;
  requestType: string;
  content: string;
  enabledManagedProviders?: ReadonlySet<string>;
}

export interface ResolvedSkill {
  id: string;
  name: string;
  summary: string;
  sourcePath: string;
  score: number;
}
