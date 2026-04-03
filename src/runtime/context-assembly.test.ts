import { describe, expect, it } from 'vitest';
import {
  buildChatMessagesFromHistory,
  buildPromptAssemblyDiagnostics,
  buildPromptAssemblyPreservedExecutionState,
  buildPromptAssemblySectionFootprints,
  buildSystemPromptWithContext,
} from './context-assembly.js';

describe('context assembly', () => {
  it('builds a bounded system prompt with ordered structured sections', () => {
    const prompt = buildSystemPromptWithContext({
      baseSystemPrompt: 'Base prompt.',
      knowledgeBases: [
        {
          scope: 'global',
          content: 'Remembered preference.',
        },
        {
          scope: 'coding_session',
          content: 'Current repo note.',
        },
      ],
      activeSkills: [
        {
          id: 'writing-plans',
          name: 'Writing Plans',
          summary: 'Creates structured implementation plans.',
        },
      ],
      pendingAction: {
        kind: 'clarification',
        prompt: 'Which provider should I use?',
        field: 'email_provider',
        transferPolicy: 'linked_surfaces_same_user',
      },
      continuity: {
        continuityKey: 'continuity-1',
        linkedSurfaceCount: 2,
        focusSummary: 'Continue the active email task.',
        lastActionableRequest: 'Check my email and summarize the latest unread message.',
        activeExecutionRefs: ['code_session:Guardian Agent'],
      },
      toolContext: 'Allowed roots: /tmp',
      runtimeNotices: [{ level: 'info', message: 'Notice one' }],
      pendingApprovalNotice: 'One unrelated approval is still pending.',
      additionalSections: ['<extra>\nhello\n</extra>'],
    });

    expect(prompt).toContain('Base prompt.');
    expect(prompt).toContain('<knowledge-base>');
    expect(prompt).toContain('<coding-memory>');
    expect(prompt).toContain('<active-skills>');
    expect(prompt).toContain('<skill>');
    expect(prompt).toContain('<writing-plan-output-contract>');
    expect(prompt).toContain('<pending-action-context>');
    expect(prompt).toContain('transferPolicy: linked_surfaces_same_user');
    expect(prompt).toContain('<continuity-context>');
    expect(prompt).toContain('continuityKey: continuity-1');
    expect(prompt).toContain('linkedSurfaceCount: 2');
    expect(prompt).toContain('<tool-context>');
    expect(prompt).toContain('<tool-runtime-notices>');
    expect(prompt).toContain('<extra>');
  });

  it('builds chat messages from structured history', () => {
    const messages = buildChatMessagesFromHistory({
      systemPrompt: 'System',
      history: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
      userContent: 'Follow up',
    });

    expect(messages).toEqual([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Follow up' },
    ]);
  });

  it('builds bounded prompt assembly diagnostics for trace surfaces', () => {
    const diagnostics = buildPromptAssemblyDiagnostics({
      memoryScope: 'global',
      knowledgeBaseContent: 'User prefers concise status updates.',
      codingMemoryContent: 'Remembered importer note.',
      knowledgeBaseQuery: 'importer overhaul verification checkpoints and parser migration follow-up',
      memorySelection: {
        candidateEntryCount: 3,
        omittedEntryCount: 1,
        entries: [
          {
            scope: 'global',
            category: 'Preferences',
            createdAt: '2026-03-18',
            preview: 'User prefers concise status updates.',
            renderMode: 'full',
            queryScore: 24,
            isContextFlush: false,
            matchReasons: ['content terms 1'],
          },
          {
            scope: 'coding_session',
            category: 'Project Notes',
            createdAt: '2026-03-20',
            preview: 'Importer overhaul note covering checkpoints, migration, retries, and verification.',
            renderMode: 'summary',
            queryScore: 312,
            isContextFlush: false,
            matchReasons: ['query summary', 'summary terms 4'],
          },
        ],
      },
      pendingAction: {
        kind: 'approval',
        prompt: 'Approve the write operation.',
        route: 'coding_task',
      },
      continuity: {
        continuityKey: 'continuity-1',
        linkedSurfaceCount: 2,
        activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
      },
      sectionFootprints: [
        { section: 'base_system_prompt', chars: 1200, included: true, mode: 'explicit' },
        { section: 'tool_context', chars: 420, included: true, mode: 'inventory' },
      ],
      preservedExecutionState: {
        objective: 'Fix the importer',
        blockerSummary: 'approval | coding_task | Approve the write operation.',
        activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
        maintainedSummarySource: 'code_session_compacted_summary',
      },
      contextCompaction: {
        applied: true,
        beforeChars: 9800,
        afterChars: 4200,
        stages: ['truncate_tool_calls', 'truncate_tool_results'],
        summary: 'Compacted prior work summary:\nassistant: Investigated importer retries and build failures.',
      },
      codeSessionId: 'code-1',
      activeSkillCount: 3,
    });

    const toolContextFootprint = diagnostics.sectionFootprints?.find((entry) => entry.section === 'tool_context');
    expect(toolContextFootprint?.chars).toBeLessThanOrEqual(600);
    expect(diagnostics.knowledgeBaseChars).toBeLessThanOrEqual(120);
    expect(diagnostics.codingMemoryChars).toBeLessThanOrEqual(120);

    expect(diagnostics.memoryScope).toBe('global');
    expect(diagnostics.knowledgeBaseLoaded).toBe(true);
    expect(diagnostics.codingMemoryLoaded).toBe(true);
    expect(diagnostics.summary).toContain('global memory loaded');
    expect(diagnostics.summary).toContain('coding memory loaded');
    expect(diagnostics.summary).toContain('continuity 2 surfaces');
    expect(diagnostics.pendingActionKind).toBe('approval');
    expect(diagnostics.selectedMemoryEntryCount).toBe(2);
    expect(diagnostics.omittedMemoryEntryCount).toBe(1);
    expect(diagnostics.contextCompactionApplied).toBe(true);
    expect(diagnostics.contextCharsBeforeCompaction).toBe(9800);
    expect(diagnostics.contextCharsAfterCompaction).toBe(4200);
    expect(diagnostics.contextCompactionStages).toEqual(['truncate_tool_calls', 'truncate_tool_results']);
    expect(diagnostics.compactedSummaryPreview).toContain('Compacted prior work summary');
    expect(diagnostics.activeExecutionRefs).toEqual(['code_session:Repo Fix', 'pending_action:approval-1']);
    expect(diagnostics.selectedMemoryEntries?.[0]?.scope).toBe('global');
    expect(buildPromptAssemblyPreservedExecutionState({
      pendingAction: { kind: 'approval', prompt: 'Approve the write operation.', route: 'coding_task' },
      continuity: { lastActionableRequest: 'Fix the importer', activeExecutionRefs: ['code_session:Repo Fix'] },
      maintainedSummarySource: 'code_session_compacted_summary',
    })).toEqual({
      objective: 'Fix the importer',
      blockerSummary: 'approval | coding_task | Approve the write operation.',
      activeExecutionRefs: ['code_session:Repo Fix'],
      maintainedSummarySource: 'code_session_compacted_summary',
    });
    expect(buildPromptAssemblySectionFootprints({
      baseSystemPrompt: 'Base prompt.',
      knowledgeBases: [{ scope: 'global', content: 'Remembered preference.' }],
      activeSkills: [{ id: 'writing-plans', name: 'Writing Plans', summary: 'Creates structured implementation plans.' }],
      toolContext: 'Allowed roots: /tmp',
      runtimeNotices: [{ level: 'info', message: 'Notice one' }],
      pendingAction: { kind: 'clarification', prompt: 'Which provider should I use?' },
      continuity: { continuityKey: 'continuity-1' },
      pendingApprovalNotice: 'One unrelated approval is still pending.',
      additionalSections: ['<extra>hello</extra>'],
    }).some((entry) => entry.section === 'tool_context' && entry.included && entry.mode === 'inventory')).toBe(true);
    expect(diagnostics.sectionFootprints?.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics.preservedExecutionState).toEqual({
      objective: 'Fix the importer',
      blockerSummary: 'approval | coding_task | Approve the write operation.',
      activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
      maintainedSummarySource: 'code_session_compacted_summary',
    });
    expect(diagnostics.selectedMemoryEntries?.[0]?.scope).toBe('global');
    expect(diagnostics.selectedMemoryEntries?.[1]?.scope).toBe('coding_session');
    expect(diagnostics.selectedMemoryEntries?.[1]?.category).toBe('Project Notes');
    expect(diagnostics.selectedMemoryEntries?.[1]?.matchReasons).toEqual(['query summary', 'summary terms 4']);
    expect(diagnostics.detail).toContain('memoryScope=global');
    expect(diagnostics.detail).toContain('codingMemory=');
    expect(diagnostics.detail).toContain('query="importer overhaul verification checkpoints');
    expect(diagnostics.detail).toContain('activeExecutionRefs=code_session:Repo Fix | pending_action:approval-1');
    expect(diagnostics.codeSessionId).toBe('code-1');
  });
});
