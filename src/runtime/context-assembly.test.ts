import { describe, expect, it } from 'vitest';
import {
  buildChatMessagesFromHistory,
  buildPromptAssemblyDiagnostics,
  buildSystemPromptWithContext,
} from './context-assembly.js';

describe('context assembly', () => {
  it('builds a bounded system prompt with ordered structured sections', () => {
    const prompt = buildSystemPromptWithContext({
      baseSystemPrompt: 'Base prompt.',
      knowledgeBase: {
        scope: 'global',
        content: 'Remembered preference.',
      },
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
    expect(prompt).toContain('<active-skills>');
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
      memoryScope: 'coding_session',
      knowledgeBaseContent: 'Remembered importer note.',
      knowledgeBaseQuery: 'importer overhaul verification checkpoints and parser migration follow-up',
      memorySelection: {
        candidateEntryCount: 3,
        omittedEntryCount: 1,
        entries: [
          {
            category: 'Project Notes',
            createdAt: '2026-03-20',
            preview: 'Importer overhaul note covering checkpoints, migration, retries, and verification.',
            renderMode: 'summary',
            queryScore: 312,
            isContextFlush: false,
            matchReasons: ['query summary', 'summary terms 4'],
          },
          {
            category: 'Preferences',
            createdAt: '2026-03-18',
            preview: 'User prefers concise status updates.',
            renderMode: 'full',
            queryScore: 24,
            isContextFlush: false,
            matchReasons: ['content terms 1'],
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
      codeSessionId: 'code-1',
      activeSkillCount: 3,
    });

    expect(diagnostics.memoryScope).toBe('coding_session');
    expect(diagnostics.knowledgeBaseLoaded).toBe(true);
    expect(diagnostics.summary).toContain('coding memory loaded');
    expect(diagnostics.summary).toContain('continuity 2 surfaces');
    expect(diagnostics.summary).toContain('blocker approval');
    expect(diagnostics.selectedMemoryEntryCount).toBe(2);
    expect(diagnostics.omittedMemoryEntryCount).toBe(1);
    expect(diagnostics.activeExecutionRefs).toEqual(['code_session:Repo Fix', 'pending_action:approval-1']);
    expect(diagnostics.selectedMemoryEntries?.[0]?.category).toBe('Project Notes');
    expect(diagnostics.selectedMemoryEntries?.[0]?.matchReasons).toEqual(['query summary', 'summary terms 4']);
    expect(diagnostics.detail).toContain('memoryScope=coding_session');
    expect(diagnostics.detail).toContain('query="importer overhaul verification checkpoints');
    expect(diagnostics.detail).toContain('activeExecutionRefs=code_session:Repo Fix | pending_action:approval-1');
    expect(diagnostics.detail).toContain('selectedMemory=Project');
    expect(diagnostics.codeSessionId).toBe('code-1');
  });
});
