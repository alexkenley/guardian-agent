export type SkillRisk = 'informational' | 'operational';
export type SkillRole = 'process' | 'domain';

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

export interface SkillUpstreamMetadata {
  source?: string;
  [key: string]: unknown;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  role?: SkillRole;
  tags?: string[];
  enabled?: boolean;
  appliesTo?: SkillAppliesTo;
  triggers?: SkillTriggers;
  tools?: string[];
  requiredCapabilities?: string[];
  requiredManagedProvider?: string;
  artifactReferences?: SkillArtifactReference[];
  risk?: SkillRisk;
  _upstream?: SkillUpstreamMetadata;
}

export interface SkillArtifactReference {
  slug: string;
  scope?: 'global' | 'coding_session';
  title?: string;
}

export interface SkillResourceEntry {
  path: string;
  kind: 'reference' | 'template' | 'example' | 'asset' | 'script';
}

export interface LoadedSkill {
  manifest: SkillManifest;
  rootDir: string;
  instructionPath: string;
  instruction: string;
  summary: string;
  resources: SkillResourceEntry[];
}

export interface SkillMaterialLoad {
  skillId: string;
  instruction?: {
    path: string;
    content: string;
    truncated: boolean;
  };
  resources: Array<{
    path: string;
    kind: SkillResourceEntry['kind'];
    content: string;
    truncated: boolean;
  }>;
  cacheHits: string[];
}

export interface SkillMaterialLoadOptions {
  maxInstructionChars?: number;
  maxResourceChars?: number;
  maxResources?: number;
  maxInstructionLoads?: number;
  maxResourceLoads?: number;
  maxArtifactLoads?: number;
  maxArtifactChars?: number;
}

export type SkillPromptArtifactSourceClass = 'canonical' | 'operator_curated' | 'derived' | 'linked_output';

export interface SkillPromptArtifactContext {
  skillId: string;
  scope: 'global' | 'coding_session';
  slug: string;
  title: string;
  sourceClass: SkillPromptArtifactSourceClass;
  content: string;
  truncated: boolean;
}

export interface SkillPromptMaterialSection {
  section: 'skill_instructions' | 'skill_resources' | 'skill_artifacts';
  content: string;
  mode: 'skill_l2' | 'skill_l3' | 'artifact';
  itemCount: number;
}

export interface SkillPromptSelectionMetadata {
  skillIds: string[];
  instructionSkillIds: string[];
  resourceSkillIds: string[];
  loadedResourcePaths: string[];
  cacheHits: string[];
  loadReasons: string[];
  artifactReferences: Array<{
    skillId: string;
    scope: 'global' | 'coding_session';
    slug: string;
    title: string;
    sourceClass: SkillPromptArtifactSourceClass;
  }>;
}

export interface SkillPromptMaterialResult {
  additionalSections: SkillPromptMaterialSection[];
  metadata: SkillPromptSelectionMetadata;
}

export interface SkillPromptMaterialInput {
  skills: readonly ResolvedSkill[];
  requestText: string;
  route?: string;
  loadOptions?: SkillMaterialLoadOptions;
  artifactReferences?: readonly SkillPromptArtifactContext[];
}

export interface SkillPromptMaterialCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface SkillStatus {
  id: string;
  name: string;
  version: string;
  description: string;
  role?: SkillRole;
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
  codeSessionAttached?: boolean;
  hasTaggedFileContext?: boolean;
  enabledManagedProviders?: ReadonlySet<string>;
  availableCapabilities?: ReadonlySet<string>;
  intentRoute?: string;
  intentTurnRelation?: string;
  intentResolution?: string;
  intentEntities?: {
    emailProvider?: string;
    calendarTarget?: string;
    codingBackend?: string;
    toolName?: string;
    profileId?: string;
    uiSurface?: string;
  };
  pendingActionKind?: string;
  continuityFocusSummary?: string;
  continuityLastActionableRequest?: string;
  priorActiveSkillIds?: readonly string[];
}

export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  role?: SkillRole;
  summary: string;
  sourcePath: string;
  score: number;
}
