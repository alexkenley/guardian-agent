import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { resumeStoredDirectRoutePendingAction, tryDirectFilesystemIntent } from './direct-route-runtime.js';

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
});

describe('direct route resume runtime', () => {
  it('dispatches automation authoring resume payloads to the automation authoring executor', async () => {
    const pendingAction = {
      id: 'pending-automation',
      scope: {
        agentId: 'default',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve policy remediation',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'automation_authoring',
        operation: 'create',
        originalUserContent: 'Create a daily automation.',
      },
      resume: {
        kind: 'direct_route',
        payload: {
          type: 'automation_authoring',
          originalUserContent: 'Create a daily automation.',
          allowRemediation: true,
        },
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    } as const;
    const completePendingAction = vi.fn();
    const executeStoredAutomationAuthoring = vi.fn(async () => ({
      content: 'Automation created.',
    }));

    const result = await resumeStoredDirectRoutePendingAction({
      pendingAction,
      options: {
        approvalResult: {
          success: true,
          approved: true,
          message: 'Approved.',
        },
      },
      completePendingAction,
      executeStoredFilesystemSave: vi.fn(),
      executeStoredAutomationAuthoring,
    });

    expect(result).toEqual({ content: 'Automation created.' });
    expect(completePendingAction).toHaveBeenCalledWith('pending-automation');
    expect(executeStoredAutomationAuthoring).toHaveBeenCalledWith(
      pendingAction,
      expect.objectContaining({
        type: 'automation_authoring',
        originalUserContent: 'Create a daily automation.',
      }),
      expect.objectContaining({ approved: true }),
    );
  });
});
