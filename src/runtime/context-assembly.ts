import type { ChatMessage } from '../llm/types.js';
import type { SkillPromptSelectionMetadata } from '../skills/types.js';
import type { SelectedExecutionProfile } from './execution-profiles.js';

export interface PromptAssemblyHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface PromptAssemblyKnowledgeBase {
  scope: 'global' | 'coding_session';
  content: string;
}

export interface PromptAssemblySkill {
  id: string;
  name: string;
  summary: string;
  description?: string;
  role?: string;
  sourcePath?: string;
}

export interface PromptAssemblyRuntimeNotice {
  level: 'info' | 'warn';
  message: string;
}

export interface PromptAssemblyAdditionalSection {
  section: string;
  content: string;
  mode?: string;
  itemCount?: number;
}

export interface PromptAssemblyPendingAction {
  kind: string;
  prompt: string;
  field?: string;
  route?: string;
  operation?: string;
  transferPolicy?: string;
  originChannel?: string;
  originSurfaceId?: string;
}

export interface PromptAssemblyContinuity {
  continuityKey?: string;
  linkedSurfaceCount?: number;
  focusSummary?: string;
  lastActionableRequest?: string;
  activeExecutionRefs?: string[];
  linkedSurfaces?: string[];
}

export interface PromptAssemblyInput {
  baseSystemPrompt: string;
  knowledgeBases?: PromptAssemblyKnowledgeBase[];
  activeSkills?: PromptAssemblySkill[];
  toolContext?: string;
  runtimeNotices?: PromptAssemblyRuntimeNotice[];
  pendingAction?: PromptAssemblyPendingAction | null;
  pendingApprovalNotice?: string;
  continuity?: PromptAssemblyContinuity | null;
  executionProfile?: SelectedExecutionProfile;
  additionalSections?: Array<string | PromptAssemblyAdditionalSection>;
}

export interface PromptAssemblySectionFootprint {
  section: string;
  chars: number;
  included: boolean;
  mode?: string;
  itemCount?: number;
}

export interface PromptAssemblyPreservedExecutionState {
  objective?: string;
  blockerSummary?: string;
  activeExecutionRefs?: string[];
  maintainedSummarySource?: string;
}

export interface PromptAssemblyDiagnostics {
  summary: string;
  detail: string;
  memoryScope: 'global' | 'coding_session' | 'none';
  knowledgeBaseLoaded: boolean;
  knowledgeBaseChars?: number;
  codingMemoryLoaded?: boolean;
  codingMemoryChars?: number;
  knowledgeBaseQueryPreview?: string;
  continuityKey?: string;
  activeExecutionRefs?: string[];
  linkedSurfaceCount?: number;
  pendingActionKind?: string;
  pendingActionRoute?: string;
  codeSessionId?: string;
  activeSkillCount?: number;
  skillInstructionSkillIds?: string[];
  skillResourceSkillIds?: string[];
  skillResourcePaths?: string[];
  skillPromptCacheHitCount?: number;
  skillPromptCacheHits?: string[];
  skillPromptLoadReasons?: string[];
  skillArtifactReferences?: SkillPromptSelectionMetadata['artifactReferences'];
  selectedMemoryEntryCount?: number;
  omittedMemoryEntryCount?: number;
  selectedMemoryEntries?: PromptAssemblyMemorySelectionEntry[];
  contextCompactionApplied?: boolean;
  contextCharsBeforeCompaction?: number;
  contextCharsAfterCompaction?: number;
  contextCompactionStages?: string[];
  compactedSummaryPreview?: string;
  sectionFootprints?: PromptAssemblySectionFootprint[];
  preservedExecutionState?: PromptAssemblyPreservedExecutionState;
  executionProfileId?: SelectedExecutionProfile['id'];
  executionProviderName?: string;
  executionProviderTier?: SelectedExecutionProfile['providerTier'];
  executionRequestedTier?: SelectedExecutionProfile['requestedTier'];
  executionPreferredAnswerPath?: SelectedExecutionProfile['preferredAnswerPath'];
  executionExpectedContextPressure?: SelectedExecutionProfile['expectedContextPressure'];
  executionContextBudget?: number;
}

export interface PromptAssemblyMemorySelectionEntry {
  scope?: 'global' | 'coding_session';
  category: string;
  createdAt: string;
  preview: string;
  renderMode: 'full' | 'summary';
  queryScore: number;
  isContextFlush: boolean;
  matchReasons?: string[];
}

export interface PromptAssemblyMemorySelection {
  candidateEntryCount: number;
  omittedEntryCount: number;
  entries: PromptAssemblyMemorySelectionEntry[];
}

export interface PromptAssemblyDiagnosticsInput {
  memoryScope: 'global' | 'coding_session' | 'none';
  knowledgeBaseContent?: string;
  codingMemoryContent?: string;
  knowledgeBaseQuery?: string;
  memorySelection?: PromptAssemblyMemorySelection;
  pendingAction?: PromptAssemblyPendingAction | null;
  continuity?: PromptAssemblyContinuity | null;
  codeSessionId?: string;
  activeSkillCount?: number;
  skillPromptSelection?: SkillPromptSelectionMetadata;
  sectionFootprints?: PromptAssemblySectionFootprint[];
  preservedExecutionState?: PromptAssemblyPreservedExecutionState;
  executionProfile?: SelectedExecutionProfile;
  contextCompaction?: {
    applied: boolean;
    beforeChars: number;
    afterChars: number;
    stages: string[];
    summary?: string;
  };
}

function wrapTaggedSection(tag: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `<${tag}>\n${trimmed}\n</${tag}>`;
}

function measureSection(section: string, content: string, options?: {
  mode?: string;
  itemCount?: number;
}): PromptAssemblySectionFootprint {
  const trimmed = content.trim();
  return {
    section,
    chars: trimmed.length,
    included: trimmed.length > 0,
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(typeof options?.itemCount === 'number' ? { itemCount: options.itemCount } : {}),
  };
}

function truncateInline(value: string | undefined, maxChars: number): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeAdditionalSections(
  sections: Array<string | PromptAssemblyAdditionalSection> | undefined,
): PromptAssemblyAdditionalSection[] {
  if (!Array.isArray(sections) || sections.length === 0) return [];
  return sections
    .map((section, index): PromptAssemblyAdditionalSection | null => {
      if (typeof section === 'string') {
        const content = section.trim();
        if (!content) return null;
        return {
          section: `additional_section_${index + 1}`,
          content,
          mode: 'targeted',
          itemCount: 1,
        };
      }
      if (!section || typeof section !== 'object') return null;
      const name = section.section?.trim();
      const content = section.content?.trim();
      if (!name || !content) return null;
      return {
        section: name,
        content,
        ...(section.mode?.trim() ? { mode: section.mode.trim() } : {}),
        ...(typeof section.itemCount === 'number' ? { itemCount: section.itemCount } : {}),
      };
    })
    .filter((section): section is PromptAssemblyAdditionalSection => !!section);
}

function formatKnowledgeBaseSection(knowledgeBase: PromptAssemblyKnowledgeBase): string {
  if (!knowledgeBase.content.trim()) return '';
  if (knowledgeBase.scope === 'coding_session') {
    return wrapTaggedSection(
      'coding-memory',
      `The following is the durable memory for this coding session only. Use it as session-local context.\n\n${knowledgeBase.content}`,
    );
  }
  return wrapTaggedSection(
    'knowledge-base',
    `The following is your persistent knowledge base — facts, preferences, and summaries you have remembered across conversations:\n\n${knowledgeBase.content}`,
  );
}

function formatKnowledgeBaseSections(knowledgeBases: PromptAssemblyKnowledgeBase[] | undefined): string[] {
  if (!Array.isArray(knowledgeBases) || knowledgeBases.length === 0) return [];
  return knowledgeBases
    .map((knowledgeBase) => formatKnowledgeBaseSection(knowledgeBase))
    .filter(Boolean);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatActiveSkillBehaviorContracts(skills: PromptAssemblySkill[] | undefined): string[] {
  if (!skills || skills.length === 0) return [];
  const sections: string[] = [];

  if (skills.some((skill) => skill.id === 'writing-plans')) {
    sections.push([
      '<writing-plan-output-contract>',
      'When producing a non-trivial implementation plan, include the headings "Acceptance Gates" and "Existing Checks To Reuse" in the written output.',
      'If the exact repo checks are not known yet, still include "Existing Checks To Reuse" and say they must be identified before adding narrower new tests.',
      'Do not block the first draft plan on repo inspection or tool use just to discover those checks.',
      '</writing-plan-output-contract>',
    ].join('\n'));
  }

  if (skills.some((skill) => skill.id === 'verification-before-completion')) {
    sections.push([
      '<verification-output-contract>',
      'Before claiming work is done, fixed, or passing, require fresh evidence on the real proof surface.',
      'Use the phrases "proof surface" and "full legitimate green" in the written response.',
      '</verification-output-contract>',
    ].join('\n'));
  }

  return sections;
}

function canonicalizePromptAssemblySkills(skills: PromptAssemblySkill[] | undefined): PromptAssemblySkill[] {
  if (!skills || skills.length === 0) return [];
  const deduped = new Map<string, PromptAssemblySkill>();
  for (const skill of skills) {
    const id = skill.id.trim();
    if (!id || deduped.has(id)) continue;
    deduped.set(id, {
      ...skill,
      id,
      name: skill.name.trim(),
      summary: skill.summary.trim(),
      ...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
      ...(skill.role?.trim() ? { role: skill.role.trim() } : {}),
      ...(skill.sourcePath?.trim() ? { sourcePath: skill.sourcePath.trim() } : {}),
    });
  }
  return [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildCanonicalPromptAssemblySkills(skills: PromptAssemblySkill[] | undefined): PromptAssemblySkill[] {
  return canonicalizePromptAssemblySkills(skills);
}

export function formatCanonicalActiveSkillIds(skills: PromptAssemblySkill[] | undefined): string[] {
  return canonicalizePromptAssemblySkills(skills).map((skill) => skill.id);
}

export function formatCodeSessionActiveSkillsPrompt(skills: PromptAssemblySkill[] | undefined): string {
  const canonicalSkillIds = formatCanonicalActiveSkillIds(skills);
  return canonicalSkillIds.length > 0 ? canonicalSkillIds.join(', ') : '(none)';
}

function formatActiveSkillsSection(skills: PromptAssemblySkill[] | undefined): string {
  const canonicalSkills = canonicalizePromptAssemblySkills(skills);
  if (canonicalSkills.length === 0) return '';
  const behaviorContracts = formatActiveSkillBehaviorContracts(canonicalSkills);
  const lines = [
    'Before any reply, clarifying question, or tool call: scan the listed skills.',
    '- If a listed skill is clearly relevant, read its SKILL.md at <location> before acting.',
    '- If multiple skills could apply, choose the most specific one first.',
    '- Read at most two SKILL.md files up front unless the task clearly needs more.',
    ...canonicalSkills.flatMap((skill) => ([
      '<skill>',
      `  <name>${escapeXml(skill.name)}</name>`,
      `  <id>${escapeXml(skill.id)}</id>`,
      ...(skill.description ? [`  <description>${escapeXml(skill.description)}</description>`] : []),
      ...(skill.role ? [`  <role>${escapeXml(skill.role)}</role>`] : []),
      `  <summary>${escapeXml(skill.summary)}</summary>`,
      ...(skill.sourcePath ? [`  <location>${escapeXml(skill.sourcePath)}</location>`] : []),
      '</skill>',
    ])),
    ...behaviorContracts,
  ];
  return wrapTaggedSection('active-skills', lines.join('\n'));
}

function formatToolContextSection(toolContext: string | undefined): string {
  return wrapTaggedSection('tool-context', toolContext ?? '');
}

function formatRuntimeNoticesSection(
  runtimeNotices: PromptAssemblyRuntimeNotice[] | undefined,
): string {
  if (!runtimeNotices || runtimeNotices.length === 0) return '';
  return wrapTaggedSection(
    'tool-runtime-notices',
    runtimeNotices.map((notice) => `- ${notice.message}`).join('\n'),
  );
}

function formatPendingActionSection(
  pendingAction: PromptAssemblyPendingAction | null | undefined,
): string {
  if (!pendingAction?.prompt.trim()) return '';
  const lines = [
    `kind: ${pendingAction.kind}`,
    ...(pendingAction.field ? [`field: ${pendingAction.field}`] : []),
    ...(pendingAction.route ? [`route: ${pendingAction.route}`] : []),
    ...(pendingAction.operation ? [`operation: ${pendingAction.operation}`] : []),
    ...(pendingAction.transferPolicy ? [`transferPolicy: ${pendingAction.transferPolicy}`] : []),
    ...(pendingAction.originChannel ? [`originChannel: ${pendingAction.originChannel}`] : []),
    ...(pendingAction.originSurfaceId ? [`originSurfaceId: ${pendingAction.originSurfaceId}`] : []),
    'prompt:',
    pendingAction.prompt,
  ];
  return wrapTaggedSection(
    'pending-action-context',
    [
      'This is active server-owned blocked-work state. Use it only when the current turn is clearly continuing or resolving that same work.',
      ...lines,
    ].join('\n'),
  );
}

function formatContinuitySection(
  continuity: PromptAssemblyContinuity | null | undefined,
): string {
  if (!continuity) return '';
  const lines = [
    ...(continuity.continuityKey ? [`continuityKey: ${continuity.continuityKey}`] : []),
    ...(typeof continuity.linkedSurfaceCount === 'number'
      ? [`linkedSurfaceCount: ${continuity.linkedSurfaceCount}`]
      : []),
    ...(continuity.focusSummary ? ['focusSummary:', continuity.focusSummary] : []),
    ...(continuity.lastActionableRequest ? ['lastActionableRequest:', continuity.lastActionableRequest] : []),
    ...(continuity.activeExecutionRefs?.length ? ['activeExecutionRefs:', ...continuity.activeExecutionRefs.map((ref) => `- ${ref}`)] : []),
    ...(continuity.linkedSurfaces?.length ? [`linkedSurfaces: ${continuity.linkedSurfaces.join(', ')}`] : []),
  ];
  return lines.length > 0 ? wrapTaggedSection('continuity-context', lines.join('\n')) : '';
}

function formatExecutionProfileSection(
  executionProfile: SelectedExecutionProfile | undefined,
): string {
  if (!executionProfile) return '';
  return wrapTaggedSection(
    'execution-profile',
    [
      'This request has a deterministic execution profile selected by Guardian routing. Follow it instead of choosing your own provider/model strategy.',
      `profileId: ${executionProfile.id}`,
      `providerName: ${executionProfile.providerName}`,
      `providerTier: ${executionProfile.providerTier}`,
      `requestedTier: ${executionProfile.requestedTier}`,
      `preferredAnswerPath: ${executionProfile.preferredAnswerPath}`,
      `expectedContextPressure: ${executionProfile.expectedContextPressure}`,
      `contextBudget: ${executionProfile.contextBudget}`,
      `toolContextMode: ${executionProfile.toolContextMode}`,
      `maxAdditionalSections: ${executionProfile.maxAdditionalSections}`,
      `maxRuntimeNotices: ${executionProfile.maxRuntimeNotices}`,
      `fallbackProviderOrder: ${executionProfile.fallbackProviderOrder.join(', ')}`,
      `selectionReason: ${executionProfile.reason}`,
    ].join('\n'),
  );
}

export function buildSystemPromptWithContext(input: PromptAssemblyInput): string {
  const canonicalSkills = canonicalizePromptAssemblySkills(input.activeSkills);
  const additionalSections = normalizeAdditionalSections(input.additionalSections);
  const sections = [
    input.baseSystemPrompt.trim(),
    ...formatKnowledgeBaseSections(input.knowledgeBases),
    formatActiveSkillsSection(canonicalSkills),
    formatPendingActionSection(input.pendingAction),
    formatContinuitySection(input.continuity),
    formatExecutionProfileSection(input.executionProfile),
    formatToolContextSection(input.toolContext),
    formatRuntimeNoticesSection(input.runtimeNotices),
    input.pendingApprovalNotice?.trim() ?? '',
    ...additionalSections.map((section) => section.content),
  ].filter(Boolean);
  return sections.join('\n\n');
}

export function buildPromptAssemblySectionFootprints(input: PromptAssemblyInput): PromptAssemblySectionFootprint[] {
  const canonicalSkills = canonicalizePromptAssemblySkills(input.activeSkills);
  const knowledgeBaseSections = formatKnowledgeBaseSections(input.knowledgeBases);
  const activeSkillsSection = formatActiveSkillsSection(canonicalSkills);
  const pendingActionSection = formatPendingActionSection(input.pendingAction);
  const continuitySection = formatContinuitySection(input.continuity);
  const executionProfileSection = formatExecutionProfileSection(input.executionProfile);
  const toolContextSection = formatToolContextSection(input.toolContext);
  const runtimeNoticesSection = formatRuntimeNoticesSection(input.runtimeNotices);
  const pendingApprovalSection = input.pendingApprovalNotice?.trim() ?? '';
  const additionalSections = normalizeAdditionalSections(input.additionalSections);

  return [
    measureSection('base_system_prompt', input.baseSystemPrompt, { mode: 'explicit' }),
    measureSection(
      'knowledge_bases',
      knowledgeBaseSections.join('\n\n'),
      { mode: 'retrieval', itemCount: input.knowledgeBases?.length ?? 0 },
    ),
    measureSection(
      'active_skills',
      activeSkillsSection,
      { mode: 'inventory', itemCount: canonicalSkills.length },
    ),
    measureSection('pending_action', pendingActionSection, { mode: 'explicit' }),
    measureSection('continuity', continuitySection, { mode: 'explicit' }),
    measureSection('execution_profile', executionProfileSection, { mode: 'explicit' }),
    measureSection('tool_context', toolContextSection, { mode: 'inventory' }),
    measureSection(
      'runtime_notices',
      runtimeNoticesSection,
      { mode: 'explicit', itemCount: input.runtimeNotices?.length ?? 0 },
    ),
    measureSection('pending_approval_notice', pendingApprovalSection, { mode: 'explicit' }),
    ...additionalSections.map((section) => measureSection(section.section, section.content, {
      mode: section.mode ?? 'targeted',
      itemCount: section.itemCount,
    })),
  ];
}

export function buildPromptAssemblyPreservedExecutionState(input: {
  pendingAction?: PromptAssemblyPendingAction | null;
  continuity?: PromptAssemblyContinuity | null;
  maintainedSummarySource?: string;
}): PromptAssemblyPreservedExecutionState | undefined {
  const objective = truncateInline(
    input.continuity?.lastActionableRequest || input.continuity?.focusSummary,
    140,
  );
  const blockerSummary = truncateInline(
    input.pendingAction
      ? [
          input.pendingAction.kind,
          input.pendingAction.route,
          input.pendingAction.operation,
          input.pendingAction.prompt,
        ].filter(Boolean).join(' | ')
      : undefined,
    140,
  );
  const activeExecutionRefs = Array.isArray(input.continuity?.activeExecutionRefs)
    ? input.continuity.activeExecutionRefs.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  const maintainedSummarySource = truncateInline(input.maintainedSummarySource, 80);

  if (!objective && !blockerSummary && activeExecutionRefs.length === 0 && !maintainedSummarySource) {
    return undefined;
  }

  return {
    ...(objective ? { objective } : {}),
    ...(blockerSummary ? { blockerSummary } : {}),
    ...(activeExecutionRefs.length > 0 ? { activeExecutionRefs } : {}),
    ...(maintainedSummarySource ? { maintainedSummarySource } : {}),
  };
}

export function summarizeCompactedPreview(summary: string | undefined, maxChars: number = 84): string | undefined {
  return truncateInline(summary, maxChars);
}

export function buildContextCompactionDiagnostics(input: {
  applied: boolean;
  beforeChars: number;
  afterChars: number;
  stages: string[];
  summary?: string;
}): PromptAssemblyDiagnosticsInput['contextCompaction'] {
  return {
    applied: input.applied,
    beforeChars: input.beforeChars,
    afterChars: input.afterChars,
    stages: input.stages,
    ...(input.summary ? { summary: input.summary } : {}),
  };
}

export function buildChatMessagesFromHistory(input: {
  systemPrompt: string;
  history?: PromptAssemblyHistoryEntry[];
  userContent: string;
}): ChatMessage[] {
  return [
    { role: 'system', content: input.systemPrompt },
    ...(input.history ?? []).map((entry): ChatMessage => ({
      role: entry.role,
      content: entry.content,
    })),
    { role: 'user', content: input.userContent },
  ];
}

export function buildPromptAssemblyDiagnostics(
  input: PromptAssemblyDiagnosticsInput,
): PromptAssemblyDiagnostics {
  const knowledgeBaseContent = input.knowledgeBaseContent?.trim() ?? '';
  const codingMemoryContent = input.codingMemoryContent?.trim() ?? '';
  const knowledgeBaseLoaded = knowledgeBaseContent.length > 0;
  const codingMemoryLoaded = codingMemoryContent.length > 0;
  const queryPreview = truncateInline(input.knowledgeBaseQuery, 80);
  const memoryLabel = input.memoryScope === 'coding_session'
    ? 'coding memory'
    : input.memoryScope === 'global'
      ? 'global memory'
      : 'memory';
  const surfaceCount = typeof input.continuity?.linkedSurfaceCount === 'number'
    ? input.continuity.linkedSurfaceCount
    : undefined;
  const selectedMemoryEntries = Array.isArray(input.memorySelection?.entries)
    ? input.memorySelection.entries.slice(0, 4)
    : [];
  const selectedMemoryPreview = selectedMemoryEntries.length > 0
    ? truncateInline(
        selectedMemoryEntries
          .map((entry) => `${entry.scope === 'coding_session' ? 'coding' : 'global'} ${entry.category}: ${entry.preview}`)
          .join(' | '),
        84,
      )
    : undefined;
  const compactionApplied = input.contextCompaction?.applied === true;
  const compactionSummaryPreview = summarizeCompactedPreview(input.contextCompaction?.summary, 84);
  const compactionStages = Array.isArray(input.contextCompaction?.stages)
    ? input.contextCompaction.stages.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  const sectionFootprints = Array.isArray(input.sectionFootprints)
    ? input.sectionFootprints
        .filter((entry) => !!entry && typeof entry.section === 'string')
        .slice(0, 12)
    : [];
  const preservedExecutionState = input.preservedExecutionState;
  const skillPromptSelection = input.skillPromptSelection;
  const skillInstructionSkillIds = Array.isArray(skillPromptSelection?.instructionSkillIds)
    ? skillPromptSelection.instructionSkillIds
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .slice(0, 4)
    : [];
  const skillResourceSkillIds = Array.isArray(skillPromptSelection?.resourceSkillIds)
    ? skillPromptSelection.resourceSkillIds
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .slice(0, 4)
    : [];
  const skillResourcePaths = Array.isArray(skillPromptSelection?.loadedResourcePaths)
    ? skillPromptSelection.loadedResourcePaths
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .slice(0, 4)
    : [];
  const skillCacheHits = Array.isArray(skillPromptSelection?.cacheHits)
    ? skillPromptSelection.cacheHits
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .slice(0, 6)
    : [];
  const skillLoadReasons = Array.isArray(skillPromptSelection?.loadReasons)
    ? skillPromptSelection.loadReasons
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .slice(0, 3)
    : [];
  const skillArtifactReferences = Array.isArray(skillPromptSelection?.artifactReferences)
    ? skillPromptSelection.artifactReferences
        .filter((value) => !!value && typeof value.slug === 'string' && typeof value.skillId === 'string')
        .slice(0, 3)
    : [];
  const sectionPreview = sectionFootprints.length > 0
    ? truncateInline(
        sectionFootprints
          .filter((entry) => entry.included)
          .map((entry) => `${entry.section}:${entry.chars}`)
          .join(' | '),
        84,
      )
    : undefined;
  const preservedStatePreview = truncateInline(
    [
      preservedExecutionState?.objective,
      preservedExecutionState?.blockerSummary,
      preservedExecutionState?.maintainedSummarySource
        ? `summary ${preservedExecutionState.maintainedSummarySource}`
        : undefined,
    ].filter(Boolean).join(' | '),
    84,
  );
  const executionProfile = input.executionProfile;
  const executionPreview = executionProfile
    ? truncateInline(
        [
          executionProfile.id,
          executionProfile.providerName,
          executionProfile.providerTier,
          executionProfile.preferredAnswerPath,
          `${executionProfile.contextBudget}`,
        ].join(' | '),
        84,
      )
    : undefined;

  const summaryParts = [
    `${memoryLabel} ${knowledgeBaseLoaded ? 'loaded' : 'empty'}`,
    ...(input.codeSessionId || codingMemoryLoaded
      ? [`coding memory ${codingMemoryLoaded ? 'loaded' : 'empty'}`]
      : []),
    ...(queryPreview ? [`query "${queryPreview}"`] : []),
    ...(surfaceCount && surfaceCount > 0 ? [`continuity ${surfaceCount} surface${surfaceCount === 1 ? '' : 's'}`] : []),
    ...(input.pendingAction?.kind ? [`blocker ${input.pendingAction.kind}`] : []),
    ...(input.codeSessionId ? [`code session ${input.codeSessionId}`] : []),
    ...(typeof input.activeSkillCount === 'number' && input.activeSkillCount > 0
      ? [`skills ${input.activeSkillCount}`]
      : []),
    ...(skillInstructionSkillIds.length > 0 ? [`skill L2 ${skillInstructionSkillIds.length}`] : []),
    ...(skillResourcePaths.length > 0 ? [`skill L3 ${skillResourcePaths.length}`] : []),
    ...(skillArtifactReferences.length > 0 ? [`skill artifacts ${skillArtifactReferences.length}`] : []),
    ...(skillCacheHits.length > 0 ? [`skill cache ${skillCacheHits.length}`] : []),
    ...(compactionApplied
      ? [`context compacted ${input.contextCompaction?.beforeChars ?? 0}->${input.contextCompaction?.afterChars ?? 0}`]
      : []),
    ...(selectedMemoryEntries.length > 0 ? [`memory picks ${selectedMemoryEntries.length}`] : []),
    ...(selectedMemoryPreview ? [`top ${selectedMemoryPreview}`] : []),
    ...(executionPreview ? [`profile ${executionPreview}`] : []),
    ...(sectionPreview ? [`sections ${sectionPreview}`] : []),
    ...(preservedStatePreview ? [`preserved ${preservedStatePreview}`] : []),
    ...(compactionSummaryPreview ? [`compacted ${compactionSummaryPreview}`] : []),
  ];
  const detailParts = [
    `memoryScope=${input.memoryScope}`,
    `knowledgeBase=${knowledgeBaseLoaded ? `${knowledgeBaseContent.length} chars` : 'empty'}`,
    ...(input.codeSessionId || codingMemoryLoaded
      ? [`codingMemory=${codingMemoryLoaded ? `${codingMemoryContent.length} chars` : 'empty'}`]
      : []),
    ...(queryPreview ? [`query="${queryPreview}"`] : []),
    ...(executionProfile
      ? [
          `executionProfile=${executionProfile.id}`,
          `executionProvider=${executionProfile.providerName}`,
          `executionTier=${executionProfile.providerTier}`,
          `requestedTier=${executionProfile.requestedTier}`,
          `preferredAnswerPath=${executionProfile.preferredAnswerPath}`,
          `expectedContextPressure=${executionProfile.expectedContextPressure}`,
          `contextBudget=${executionProfile.contextBudget}`,
        ]
      : []),
    ...(input.continuity?.continuityKey ? [`continuityKey=${input.continuity.continuityKey}`] : []),
    ...(input.continuity?.activeExecutionRefs?.length
      ? [`activeExecutionRefs=${input.continuity.activeExecutionRefs.join(' | ')}`]
      : []),
    ...(surfaceCount && surfaceCount > 0 ? [`linkedSurfaces=${surfaceCount}`] : []),
    ...(input.pendingAction?.kind ? [`pendingAction=${input.pendingAction.kind}`] : []),
    ...(input.pendingAction?.route ? [`route=${input.pendingAction.route}`] : []),
    ...(input.codeSessionId ? [`codeSessionId=${input.codeSessionId}`] : []),
    ...(typeof input.activeSkillCount === 'number' && input.activeSkillCount > 0
      ? [`activeSkills=${input.activeSkillCount}`]
      : []),
    ...(skillInstructionSkillIds.length > 0 ? [`skillInstructions=${skillInstructionSkillIds.join('|')}`] : []),
    ...(skillResourceSkillIds.length > 0 ? [`skillResources=${skillResourceSkillIds.join('|')}`] : []),
    ...(skillResourcePaths.length > 0 ? [`skillResourcePaths=${skillResourcePaths.join('|')}`] : []),
    ...(skillCacheHits.length > 0 ? [`skillCacheHits=${skillCacheHits.join('|')}`] : []),
    ...(skillArtifactReferences.length > 0
      ? [`skillArtifacts=${skillArtifactReferences.map((entry) => `${entry.skillId}:${entry.scope}:${entry.slug}`).join('|')}`]
      : []),
    ...(skillLoadReasons.length > 0 ? [`skillLoadReasons="${skillLoadReasons.join(' | ')}"`] : []),
    ...(sectionFootprints.length > 0
      ? [`sections=${sectionFootprints.map((entry) => `${entry.section}:${entry.included ? entry.chars : 0}`).join('|')}`]
      : []),
    ...(preservedExecutionState?.objective ? [`objective="${preservedExecutionState.objective}"`] : []),
    ...(preservedExecutionState?.blockerSummary ? [`blockerSummary="${preservedExecutionState.blockerSummary}"`] : []),
    ...(preservedExecutionState?.maintainedSummarySource ? [`maintainedSummarySource=${preservedExecutionState.maintainedSummarySource}`] : []),
    ...(compactionApplied
      ? [
          `contextCompacted=${input.contextCompaction?.beforeChars ?? 0}->${input.contextCompaction?.afterChars ?? 0}`,
          ...(compactionStages.length > 0 ? [`compactionStages=${compactionStages.join('|')}`] : []),
          ...(compactionSummaryPreview ? [`compactedSummary="${compactionSummaryPreview}"`] : []),
        ]
      : []),
    ...(selectedMemoryEntries.length > 0
      ? [`selectedMemory=${selectedMemoryEntries.map((entry) =>
          `${entry.category}:${entry.renderMode}:${(entry.matchReasons ?? []).slice(0, 2).join('&') || 'matched'}:${entry.preview}`).join(' | ')}`]
      : []),
    ...(typeof input.memorySelection?.omittedEntryCount === 'number' && input.memorySelection.omittedEntryCount > 0
      ? [`omittedMemory=${input.memorySelection.omittedEntryCount}`]
      : []),
  ];

  return {
    summary: truncateInline(summaryParts.join(' | '), 160) ?? `${memoryLabel} ${knowledgeBaseLoaded ? 'loaded' : 'empty'}`,
    detail: truncateInline(detailParts.join('; '), 360) ?? `memoryScope=${input.memoryScope}`,
    memoryScope: input.memoryScope,
    knowledgeBaseLoaded,
    ...(knowledgeBaseLoaded ? { knowledgeBaseChars: knowledgeBaseContent.length } : {}),
    ...(input.codeSessionId || codingMemoryLoaded ? { codingMemoryLoaded } : {}),
    ...(codingMemoryLoaded ? { codingMemoryChars: codingMemoryContent.length } : {}),
    ...(queryPreview ? { knowledgeBaseQueryPreview: queryPreview } : {}),
    ...(input.continuity?.continuityKey ? { continuityKey: input.continuity.continuityKey } : {}),
    ...(input.continuity?.activeExecutionRefs?.length ? { activeExecutionRefs: [...input.continuity.activeExecutionRefs] } : {}),
    ...(typeof surfaceCount === 'number' ? { linkedSurfaceCount: surfaceCount } : {}),
    ...(input.pendingAction?.kind ? { pendingActionKind: input.pendingAction.kind } : {}),
    ...(input.pendingAction?.route ? { pendingActionRoute: input.pendingAction.route } : {}),
    ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    ...(typeof input.activeSkillCount === 'number' ? { activeSkillCount: input.activeSkillCount } : {}),
    ...(skillInstructionSkillIds.length > 0 ? { skillInstructionSkillIds } : {}),
    ...(skillResourceSkillIds.length > 0 ? { skillResourceSkillIds } : {}),
    ...(skillResourcePaths.length > 0 ? { skillResourcePaths } : {}),
    ...(skillCacheHits.length > 0 ? { skillPromptCacheHitCount: skillCacheHits.length, skillPromptCacheHits: skillCacheHits } : {}),
    ...(skillLoadReasons.length > 0 ? { skillPromptLoadReasons: skillLoadReasons } : {}),
    ...(skillArtifactReferences.length > 0 ? { skillArtifactReferences } : {}),
    ...(executionProfile
      ? {
          executionProfileId: executionProfile.id,
          executionProviderName: executionProfile.providerName,
          executionProviderTier: executionProfile.providerTier,
          executionRequestedTier: executionProfile.requestedTier,
          executionPreferredAnswerPath: executionProfile.preferredAnswerPath,
          executionExpectedContextPressure: executionProfile.expectedContextPressure,
          executionContextBudget: executionProfile.contextBudget,
        }
      : {}),
    ...(compactionApplied ? { contextCompactionApplied: true } : {}),
    ...(compactionApplied && typeof input.contextCompaction?.beforeChars === 'number'
      ? { contextCharsBeforeCompaction: input.contextCompaction.beforeChars }
      : {}),
    ...(compactionApplied && typeof input.contextCompaction?.afterChars === 'number'
      ? { contextCharsAfterCompaction: input.contextCompaction.afterChars }
      : {}),
    ...(compactionStages.length > 0 ? { contextCompactionStages: compactionStages } : {}),
    ...(compactionSummaryPreview ? { compactedSummaryPreview: compactionSummaryPreview } : {}),
    ...(sectionFootprints.length > 0 ? { sectionFootprints } : {}),
    ...(preservedExecutionState ? { preservedExecutionState } : {}),
    ...(selectedMemoryEntries.length > 0
      ? {
          selectedMemoryEntryCount: selectedMemoryEntries.length,
          selectedMemoryEntries,
        }
      : {}),
    ...(typeof input.memorySelection?.omittedEntryCount === 'number'
      ? { omittedMemoryEntryCount: input.memorySelection.omittedEntryCount }
      : {}),
  };
}
