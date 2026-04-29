import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  tryDirectCodingBackendDelegation,
  type DirectCodingBackendDeps,
} from './direct-coding-backend.js';

const TEST_CONTEXT: AgentContext = {
  agentId: 'assistant',
  emit: async () => undefined,
  checkAction: () => undefined,
  capabilities: [],
};

function makeMessage(content: string): UserMessage {
  return {
    id: 'msg-1',
    userId: 'user-1',
    surfaceId: 'web-guardian-chat',
    channel: 'web',
    content,
    timestamp: 1,
  };
}

function makeDecision(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'create',
    summary: 'Run a coding backend.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'tool_orchestration',
    preferredTier: 'local',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'tool_loop',
    entities: {
      codingBackend: 'codex',
    },
    ...overrides,
  };
}

function makePendingAction(input: {
  prompt: string;
  approvalIds: string[];
  originalUserContent: string;
  resume?: PendingActionRecord['resume'];
  codeSessionId?: string;
}): PendingActionRecord {
  return {
    id: 'pending-1',
    scope: {
      agentId: 'assistant',
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    },
    status: 'pending',
    transferPolicy: 'origin_surface_only',
    blocker: {
      kind: 'approval',
      prompt: input.prompt,
      approvalIds: input.approvalIds,
    },
    intent: {
      route: 'coding_task',
      operation: 'create',
      originalUserContent: input.originalUserContent,
    },
    resume: input.resume,
    codeSessionId: input.codeSessionId,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
}

function makeDeps(overrides: Partial<DirectCodingBackendDeps> = {}): DirectCodingBackendDeps {
  return {
    agentId: 'assistant',
    tools: {
      isEnabled: () => true,
      executeModelTool: async () => ({ success: true }),
      getApprovalSummaries: () => new Map(),
    } as DirectCodingBackendDeps['tools'],
    codeSessionStore: {
      getSession: () => ({
        id: 'code-1',
        title: 'GuardianAgent',
        ownerUserId: 'user-1',
        workspaceRoot: 'S:/Development/GuardianAgent',
        createdAt: 1,
        updatedAt: 1,
        lastAttachedAt: 1,
      }),
    } as DirectCodingBackendDeps['codeSessionStore'],
    parsePendingActionUserKey: () => ({ userId: 'user-1', channel: 'web' }),
    ensureExplicitCodingTaskWorkspaceTarget: async () => ({ status: 'unchanged' }),
    recordIntentRoutingTrace: () => undefined,
    getPendingApprovalIds: () => [],
    setPendingApprovals: () => undefined,
    syncPendingApprovalsFromExecutor: () => undefined,
    setPendingApprovalAction: (_userId, _channel, surfaceId, input) => ({
      action: makePendingAction({
        prompt: input.prompt,
        approvalIds: input.approvalIds,
        originalUserContent: input.originalUserContent,
        resume: input.resume,
        codeSessionId: input.codeSessionId,
      }),
      ...(surfaceId ? {} : {}),
    }),
    ...overrides,
  };
}

describe('direct coding backend delegation', () => {
  it('leaves structured remote sandbox execution requests for remote execution routing', async () => {
    const executeModelTool = vi.fn(async () => ({ success: true }));
    const ensureExplicitCodingTaskWorkspaceTarget = vi.fn(async () => ({ status: 'unchanged' as const }));

    const response = await tryDirectCodingBackendDelegation(
      {
        message: makeMessage('Run pwd in the remote sandbox using the Vercel Production profile.'),
        ctx: TEST_CONTEXT,
        userKey: 'user-1:web',
        decision: makeDecision({
          entities: {
            codingBackend: 'codex',
            codingBackendRequested: true,
            codingRemoteExecRequested: true,
            profileId: 'vercel-production',
            command: 'pwd',
          },
        }),
        codeContext: {
          sessionId: 'code-1',
          workspaceRoot: 'S:/Development/GuardianAgent',
        },
      },
      makeDeps({
        tools: {
          isEnabled: () => true,
          executeModelTool,
          getApprovalSummaries: () => new Map(),
        } as DirectCodingBackendDeps['tools'],
        ensureExplicitCodingTaskWorkspaceTarget,
      }),
    );

    expect(response).toBeNull();
    expect(executeModelTool).not.toHaveBeenCalled();
    expect(ensureExplicitCodingTaskWorkspaceTarget).not.toHaveBeenCalled();
  });

  it('runs direct coding backend tasks through the shared tool executor', async () => {
    const executeModelTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        success: true,
        backendId: 'codex',
        backendName: 'Codex',
        assistantResponse: 'Implemented the requested change.',
        durationMs: 25,
      },
    }));

    const response = await tryDirectCodingBackendDelegation(
      {
        message: makeMessage('Ask Codex to implement the requested change.'),
        ctx: TEST_CONTEXT,
        userKey: 'user-1:web',
        decision: makeDecision(),
        codeContext: {
          sessionId: 'code-1',
          workspaceRoot: 'S:/Development/GuardianAgent',
        },
      },
      makeDeps({
        tools: {
          isEnabled: () => true,
          executeModelTool,
          getApprovalSummaries: () => new Map(),
        } as DirectCodingBackendDeps['tools'],
      }),
    );

    expect(executeModelTool).toHaveBeenCalledWith(
      'coding_backend_run',
      {
        task: 'Ask Codex to implement the requested change.',
        backend: 'codex',
      },
      expect.objectContaining({
        agentId: 'assistant',
        userId: 'user-1',
        codeContext: {
          sessionId: 'code-1',
          workspaceRoot: 'S:/Development/GuardianAgent',
        },
      }),
    );
    expect(response).toMatchObject({
      content: 'Implemented the requested change.',
      metadata: {
        codingBackendDelegated: true,
        codingBackendId: 'codex',
        codeSessionResolved: true,
        codeSessionId: 'code-1',
        responseSource: {
          providerName: 'Codex',
          durationMs: 25,
        },
      },
    });
  });

  it('formats recent coding backend status checks from backend status output', async () => {
    const response = await tryDirectCodingBackendDelegation(
      {
        message: makeMessage('What happened with the last Codex run?'),
        ctx: TEST_CONTEXT,
        userKey: 'user-1:web',
        decision: makeDecision({
          operation: 'inspect',
          entities: {
            codingBackend: 'codex',
            codingRunStatusCheck: true,
          },
        }),
        codeContext: {
          sessionId: 'code-1',
          workspaceRoot: 'S:/Development/GuardianAgent',
        },
      },
      makeDeps({
        tools: {
          isEnabled: () => true,
          executeModelTool: async () => ({
            success: true,
            status: 'succeeded',
            output: {
              sessions: [
                {
                  backendId: 'codex',
                  backendName: 'Codex',
                  status: 'succeeded',
                  task: 'Fix tests',
                  completedAt: 20,
                  durationMs: 11,
                },
              ],
            },
          }),
          getApprovalSummaries: () => new Map(),
        } as DirectCodingBackendDeps['tools'],
      }),
    );

    expect(response?.content).toContain('The most recent Codex run completed successfully.');
    expect(response?.content).toContain('Task: Fix tests');
    expect(response?.content).toContain('Duration: 11ms');
  });

  it('stores pending coding backend approvals as shared pending actions', async () => {
    let capturedPendingActionInput: Record<string, unknown> | null = null;
    const setPendingApprovals = vi.fn();

    const response = await tryDirectCodingBackendDelegation(
      {
        message: makeMessage('Ask Codex to make the architecture change.'),
        ctx: TEST_CONTEXT,
        userKey: 'user-1:web',
        decision: makeDecision(),
        codeContext: {
          sessionId: 'code-1',
          workspaceRoot: 'S:/Development/GuardianAgent',
        },
      },
      makeDeps({
        tools: {
          isEnabled: () => true,
          executeModelTool: async () => ({
            success: false,
            status: 'pending_approval',
            approvalId: 'approval-1',
          }),
          getApprovalSummaries: () => new Map([
            ['approval-1', { toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}' }],
          ]),
        } as DirectCodingBackendDeps['tools'],
        setPendingApprovals,
        setPendingApprovalAction: (_userId, _channel, _surfaceId, input) => {
          capturedPendingActionInput = input;
          return {
            action: makePendingAction({
              prompt: input.prompt,
              approvalIds: input.approvalIds,
              originalUserContent: input.originalUserContent,
              resume: input.resume,
              codeSessionId: input.codeSessionId,
            }),
          };
        },
      }),
    );

    expect(setPendingApprovals).toHaveBeenCalledWith(
      'user-1:web',
      ['approval-1'],
      'web-guardian-chat',
    );
    expect(capturedPendingActionInput).toMatchObject({
      approvalIds: ['approval-1'],
      originalUserContent: 'Ask Codex to make the architecture change.',
      route: 'coding_task',
      codeSessionId: 'code-1',
    });
    expect(capturedPendingActionInput?.resume).toBeUndefined();
    expect(response?.metadata?.pendingAction).toMatchObject({
      id: 'pending-1',
      blocker: {
        kind: 'approval',
        approvalIds: ['approval-1'],
      },
    });
  });
});
