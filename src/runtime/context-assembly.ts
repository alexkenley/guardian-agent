import type { ChatMessage } from '../llm/types.js';

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
}

export interface PromptAssemblyRuntimeNotice {
  level: 'info' | 'warn';
  message: string;
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
  knowledgeBase?: PromptAssemblyKnowledgeBase;
  activeSkills?: PromptAssemblySkill[];
  toolContext?: string;
  runtimeNotices?: PromptAssemblyRuntimeNotice[];
  pendingAction?: PromptAssemblyPendingAction | null;
  pendingApprovalNotice?: string;
  continuity?: PromptAssemblyContinuity | null;
  additionalSections?: string[];
}

export interface PromptAssemblyDiagnostics {
  summary: string;
  detail: string;
  memoryScope: 'global' | 'coding_session' | 'none';
  knowledgeBaseLoaded: boolean;
  knowledgeBaseChars?: number;
  knowledgeBaseQueryPreview?: string;
  continuityKey?: string;
  activeExecutionRefs?: string[];
  linkedSurfaceCount?: number;
  pendingActionKind?: string;
  pendingActionRoute?: string;
  codeSessionId?: string;
  activeSkillCount?: number;
  selectedMemoryEntryCount?: number;
  omittedMemoryEntryCount?: number;
  selectedMemoryEntries?: PromptAssemblyMemorySelectionEntry[];
}

export interface PromptAssemblyMemorySelectionEntry {
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
  knowledgeBaseQuery?: string;
  memorySelection?: PromptAssemblyMemorySelection;
  pendingAction?: PromptAssemblyPendingAction | null;
  continuity?: PromptAssemblyContinuity | null;
  codeSessionId?: string;
  activeSkillCount?: number;
}

function wrapTaggedSection(tag: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `<${tag}>\n${trimmed}\n</${tag}>`;
}

function truncateInline(value: string | undefined, maxChars: number): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatKnowledgeBaseSection(knowledgeBase: PromptAssemblyKnowledgeBase | undefined): string {
  if (!knowledgeBase?.content.trim()) return '';
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

function formatActiveSkillsSection(skills: PromptAssemblySkill[] | undefined): string {
  if (!skills || skills.length === 0) return '';
  return wrapTaggedSection(
    'active-skills',
    skills
      .map((skill) => `Skill: ${skill.name} (${skill.id})\nSummary:\n${skill.summary}`)
      .join('\n\n'),
  );
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

export function buildSystemPromptWithContext(input: PromptAssemblyInput): string {
  const sections = [
    input.baseSystemPrompt.trim(),
    formatKnowledgeBaseSection(input.knowledgeBase),
    formatActiveSkillsSection(input.activeSkills),
    formatPendingActionSection(input.pendingAction),
    formatContinuitySection(input.continuity),
    formatToolContextSection(input.toolContext),
    formatRuntimeNoticesSection(input.runtimeNotices),
    input.pendingApprovalNotice?.trim() ?? '',
    ...(input.additionalSections ?? []).map((section) => section.trim()).filter(Boolean),
  ].filter(Boolean);
  return sections.join('\n\n');
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
  const knowledgeBaseLoaded = knowledgeBaseContent.length > 0;
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
    ? input.memorySelection.entries.slice(0, 3)
    : [];
  const selectedMemoryPreview = selectedMemoryEntries.length > 0
    ? truncateInline(
        selectedMemoryEntries
          .map((entry) => `${entry.category}: ${entry.preview}`)
          .join(' | '),
        84,
      )
    : undefined;

  const summaryParts = [
    `${memoryLabel} ${knowledgeBaseLoaded ? 'loaded' : 'empty'}`,
    ...(queryPreview ? [`query "${queryPreview}"`] : []),
    ...(surfaceCount && surfaceCount > 0 ? [`continuity ${surfaceCount} surface${surfaceCount === 1 ? '' : 's'}`] : []),
    ...(input.pendingAction?.kind ? [`blocker ${input.pendingAction.kind}`] : []),
    ...(input.codeSessionId ? [`code session ${input.codeSessionId}`] : []),
    ...(typeof input.activeSkillCount === 'number' && input.activeSkillCount > 0
      ? [`skills ${input.activeSkillCount}`]
      : []),
    ...(selectedMemoryEntries.length > 0 ? [`memory picks ${selectedMemoryEntries.length}`] : []),
    ...(selectedMemoryPreview ? [`top ${selectedMemoryPreview}`] : []),
  ];
  const detailParts = [
    `memoryScope=${input.memoryScope}`,
    `knowledgeBase=${knowledgeBaseLoaded ? `${knowledgeBaseContent.length} chars` : 'empty'}`,
    ...(queryPreview ? [`query="${queryPreview}"`] : []),
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
    ...(queryPreview ? { knowledgeBaseQueryPreview: queryPreview } : {}),
    ...(input.continuity?.continuityKey ? { continuityKey: input.continuity.continuityKey } : {}),
    ...(input.continuity?.activeExecutionRefs?.length ? { activeExecutionRefs: [...input.continuity.activeExecutionRefs] } : {}),
    ...(typeof surfaceCount === 'number' ? { linkedSurfaceCount: surfaceCount } : {}),
    ...(input.pendingAction?.kind ? { pendingActionKind: input.pendingAction.kind } : {}),
    ...(input.pendingAction?.route ? { pendingActionRoute: input.pendingAction.route } : {}),
    ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    ...(typeof input.activeSkillCount === 'number' ? { activeSkillCount: input.activeSkillCount } : {}),
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
