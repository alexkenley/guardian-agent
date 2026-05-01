import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { tryDirectFilesystemIntent } from './direct-route-runtime.js';

function message(content: string): UserMessage {
  return {
    id: 'msg-1',
    content,
    userId: 'owner',
    channel: 'web',
    timestamp: Date.now(),
  };
}

function context(): AgentContext {
  return {
    capabilities: [],
    checkAction: vi.fn(() => ({ allowed: true })),
  } as unknown as AgentContext;
}

function decision(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayDecision {
  return {
    route: 'filesystem_task',
    confidence: 'high',
    operation: 'create',
    summary: 'Search then write.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    preferredTier: 'local',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'tool_loop',
    entities: {},
    plannedSteps: [
      { kind: 'search', summary: 'Search the repo.', required: true },
      { kind: 'write', summary: 'Write the summary file.', required: true, dependsOn: ['step_1'] },
    ],
    ...overrides,
  };
}

describe('direct route filesystem runtime', () => {
  it('defers read/write filesystem hybrids to delegated orchestration', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
      getApprovalSummaries: vi.fn(),
      getPolicy: vi.fn(() => ({})),
    };

    const result = await tryDirectFilesystemIntent({
      message: message('Search this repo for strings that look like API keys. Write only paths to tmp/manual-web/secret-scan-paths.txt.'),
      ctx: context(),
      userKey: 'owner:web',
      conversationKey: { agentId: 'default', userId: 'owner', channel: 'web' },
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      gatewayDecision: decision(),
      agentId: 'default',
      tools,
      conversationService: { getSessionHistory: vi.fn(() => []) },
      executeStoredFilesystemSave: vi.fn(),
      setApprovalFollowUp: vi.fn(),
      getPendingApprovals: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => ''),
      setPendingApprovalActionForRequest: vi.fn(),
      buildPendingApprovalBlockedResponse: vi.fn(),
    });

    expect(result).toBeNull();
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('defers mutating filesystem requests even when the classifier omits planned steps', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
      getApprovalSummaries: vi.fn(),
      getPolicy: vi.fn(() => ({})),
    };

    const result = await tryDirectFilesystemIntent({
      message: message('Search this repo for strings that look like API keys. Write only paths to tmp/manual-web/secret-scan-paths.txt.'),
      ctx: context(),
      userKey: 'owner:web',
      conversationKey: { agentId: 'default', userId: 'owner', channel: 'web' },
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      gatewayDecision: decision({ plannedSteps: undefined }),
      agentId: 'default',
      tools,
      conversationService: { getSessionHistory: vi.fn(() => []) },
      executeStoredFilesystemSave: vi.fn(),
      setApprovalFollowUp: vi.fn(),
      getPendingApprovals: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => ''),
      setPendingApprovalActionForRequest: vi.fn(),
      buildPendingApprovalBlockedResponse: vi.fn(),
    });

    expect(result).toBeNull();
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('asks for a save target instead of delegating an assistant-output save with no path', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
      getApprovalSummaries: vi.fn(),
      getPolicy: vi.fn(() => ({})),
    };
    const executeStoredFilesystemSave = vi.fn();
    const setClarificationPendingAction = vi.fn(() => ({ action: null }));

    const result = await tryDirectFilesystemIntent({
      message: message('Can you save that information as a text file?'),
      ctx: context(),
      userKey: 'owner:web',
      conversationKey: { agentId: 'default', userId: 'owner', channel: 'web' },
      codeContext: { workspaceRoot: 'S:/Development/TestApp', sessionId: 'code-1' },
      gatewayDecision: decision({
        operation: 'create',
        summary: 'Save the previous answer to a file.',
        plannedSteps: [
          { kind: 'write', summary: 'Write a text file.', required: true },
        ],
      }),
      agentId: 'default',
      tools,
      conversationService: { getSessionHistory: vi.fn(() => [{ role: 'assistant', content: 'Config options overview.' }]) },
      executeStoredFilesystemSave,
      setApprovalFollowUp: vi.fn(),
      parsePendingActionUserKey: vi.fn(() => ({ userId: 'owner', channel: 'web' })),
      setClarificationPendingAction,
      getPendingApprovals: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => ''),
      setPendingApprovalActionForRequest: vi.fn(),
      buildPendingApprovalBlockedResponse: vi.fn(),
    });

    expect(result).toMatchObject({
      content: 'What file name or full path should I use to save the previous assistant output?',
    });
    expect(setClarificationPendingAction).toHaveBeenCalledWith(
      'owner',
      'web',
      undefined,
      expect.objectContaining({
        blockerKind: 'clarification',
        field: 'path',
        route: 'filesystem_task',
        operation: 'save',
        missingFields: ['path'],
      }),
    );
    expect(executeStoredFilesystemSave).not.toHaveBeenCalled();
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('saves the original assistant output after a save-target clarification answer', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
      getApprovalSummaries: vi.fn(),
      getPolicy: vi.fn(() => ({})),
    };
    const executeStoredFilesystemSave = vi.fn(async () => 'saved');

    const result = await tryDirectFilesystemIntent({
      message: message('Use path S:/Development/TestApp/config-options.txt for this request: Can you save that information as a text file?'),
      ctx: context(),
      userKey: 'owner:web',
      conversationKey: { agentId: 'default', userId: 'owner', channel: 'web' },
      codeContext: { workspaceRoot: 'S:/Development/TestApp', sessionId: 'code-1' },
      gatewayDecision: decision({
        operation: 'save',
        turnRelation: 'clarification_answer',
        entities: { path: 'S:/Development/TestApp/config-options.txt' },
        plannedSteps: undefined,
      }),
      agentId: 'default',
      tools,
      conversationService: {
        getSessionHistory: vi.fn(() => [
          { role: 'assistant', content: 'Config options overview.' },
          { role: 'assistant', content: 'What file name or full path should I use to save the previous assistant output?' },
        ]),
      },
      executeStoredFilesystemSave,
      setApprovalFollowUp: vi.fn(),
      parsePendingActionUserKey: vi.fn(() => ({ userId: 'owner', channel: 'web' })),
      setClarificationPendingAction: vi.fn(),
      getPendingApprovals: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => ''),
      setPendingApprovalActionForRequest: vi.fn(),
      buildPendingApprovalBlockedResponse: vi.fn(),
    });

    expect(result).toBe('saved');
    expect(executeStoredFilesystemSave).toHaveBeenCalledWith(expect.objectContaining({
      targetPath: 'S:/Development/TestApp/config-options.txt',
      content: 'Config options overview.',
      originalUserContent: 'Use path S:/Development/TestApp/config-options.txt for this request: Can you save that information as a text file?',
    }));
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('defers repo-grounded search and answer requests to synthesis orchestration', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
      getApprovalSummaries: vi.fn(),
      getPolicy: vi.fn(() => ({})),
    };

    const result = await tryDirectFilesystemIntent({
      message: message('Search this workspace for where execution graph mutation approval resume events are emitted and tell me the exact file.'),
      ctx: context(),
      userKey: 'owner:web',
      conversationKey: { agentId: 'default', userId: 'owner', channel: 'web' },
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      gatewayDecision: decision({
        route: 'coding_task',
        operation: 'search',
        summary: 'Search repo and answer with exact files.',
        requiresToolSynthesis: false,
        preferredAnswerPath: 'direct',
        plannedSteps: [
          { kind: 'search', summary: 'Search the repo.', required: true },
          { kind: 'answer', summary: 'Answer with exact files.', required: true, dependsOn: ['step_1'] },
        ],
      }),
      agentId: 'default',
      tools,
      conversationService: { getSessionHistory: vi.fn(() => []) },
      executeStoredFilesystemSave: vi.fn(),
      setApprovalFollowUp: vi.fn(),
      getPendingApprovals: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => ''),
      setPendingApprovalActionForRequest: vi.fn(),
      buildPendingApprovalBlockedResponse: vi.fn(),
    });

    expect(result).toBeNull();
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('keeps simple filesystem search requests on the direct filesystem path', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: true,
        output: {
          root: 'S:/Development/GuardianAgent',
          scannedFiles: 12,
          truncated: false,
          matches: [
            { relativePath: 'package.json', matchType: 'name' },
          ],
        },
      })),
      getApprovalSummaries: vi.fn(),
      getPolicy: vi.fn(() => ({ sandbox: { allowedPaths: ['S:/Development/GuardianAgent'] } })),
    };

    const result = await tryDirectFilesystemIntent({
      message: message('Search this workspace for "package.json".'),
      ctx: context(),
      userKey: 'owner:web',
      conversationKey: { agentId: 'default', userId: 'owner', channel: 'web' },
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      gatewayDecision: decision({
        operation: 'search',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        requireExactFileReferences: false,
        executionClass: 'tool',
        preferredAnswerPath: 'direct',
        plannedSteps: [
          { kind: 'search', summary: 'Search files.', required: true },
        ],
      }),
      agentId: 'default',
      tools,
      conversationService: { getSessionHistory: vi.fn(() => []) },
      executeStoredFilesystemSave: vi.fn(),
      setApprovalFollowUp: vi.fn(),
      getPendingApprovals: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => ''),
      setPendingApprovalActionForRequest: vi.fn(),
      buildPendingApprovalBlockedResponse: vi.fn(),
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('package.json');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'fs_search',
      expect.objectContaining({
        path: 'S:/Development/GuardianAgent',
        query: 'package.json',
      }),
      expect.objectContaining({ origin: 'assistant' }),
    );
  });
});
