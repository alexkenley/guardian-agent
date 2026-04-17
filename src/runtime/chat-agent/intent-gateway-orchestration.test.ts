import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayRecord } from '../intent-gateway.js';
import type { ContinuityThreadRecord } from '../continuity-threads.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  buildGatewayClarificationResponse,
  resolveIntentGatewayContent,
  resolvePendingActionContinuationContent,
  resolveRetryAfterFailureContinuationContent,
  shouldClearPendingActionAfterTurn,
  toPendingActionEntities,
  tryHandlePendingActionSwitchDecision,
  tryHandleWorkspaceSwitchContinuation,
} from './intent-gateway-orchestration.js';

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

function makeGatewayRecord(
  overrides: Partial<IntentGatewayRecord['decision']> = {},
): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 1,
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'read',
      summary: 'Test summary',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'direct_assistant',
      preferredTier: 'local',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
      entities: {},
      ...overrides,
    },
  };
}

function makePendingAction(
  overrides: {
    blocker?: Partial<PendingActionRecord['blocker']>;
    intent?: Partial<PendingActionRecord['intent']>;
    resume?: PendingActionRecord['resume'];
    codeSessionId?: string;
  } = {},
): PendingActionRecord {
  return {
    id: 'pending-1',
    scope: {
      agentId: 'assistant',
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    },
    status: 'pending',
    transferPolicy: 'linked_surfaces_same_user',
    blocker: {
      kind: 'clarification',
      prompt: 'Need clarification.',
      ...(overrides.blocker ?? {}),
    },
    intent: {
      route: 'general_assistant',
      operation: 'read',
      originalUserContent: 'Do the thing.',
      ...(overrides.intent ?? {}),
    },
    ...(overrides.resume ? { resume: overrides.resume } : {}),
    ...(overrides.codeSessionId ? { codeSessionId: overrides.codeSessionId } : {}),
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
}

function makeContinuityThread(
  overrides: Partial<ContinuityThreadRecord> = {},
): ContinuityThreadRecord {
  return {
    continuityKey: 'assistant:user-1',
    scope: {
      assistantId: 'assistant',
      userId: 'user-1',
    },
    linkedSurfaces: [],
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

describe('intent-gateway-orchestration', () => {
  it('preserves provenance in email clarification pending actions and traces', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const traceCalls: Array<{ stage: string; details: Record<string, unknown> }> = [];
    const gateway = makeGatewayRecord({
      route: 'email_task',
      resolution: 'needs_clarification',
      missingFields: ['email_provider'],
      summary: 'Need the mailbox provider.',
      provenance: {
        route: 'classifier.primary',
        operation: 'classifier.primary',
        entities: {
          emailProvider: 'resolver.email',
        },
      },
      entities: {
        query: 'project updates',
      },
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Check my project updates inbox'),
        activeSkills: [],
      },
      {
        enabledManagedProviders: new Set(['gws', 'm365']),
        buildImmediateResponseMetadata: () => ({ continuity: { continuityKey: 'assistant:user-1' } }),
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: (stage, input) => {
          traceCalls.push({ stage, details: input.details });
        },
        toPendingActionEntities,
      },
    );

    expect(response?.content).toContain('Which one do you want me to use?');
    expect(response?.metadata).toMatchObject({
      continuity: { continuityKey: 'assistant:user-1' },
      intentGateway: expect.any(Object),
    });
    expect(pendingActionInputs[0]).toMatchObject({
      field: 'email_provider',
      provenance: gateway.decision.provenance,
      entities: {
        query: 'project updates',
      },
    });
    expect(traceCalls).toEqual([
      {
        stage: 'clarification_requested',
        details: expect.objectContaining({
          kind: 'email_provider',
          route: 'email_task',
          routeSource: 'classifier.primary',
          operation: 'read',
          operationSource: 'classifier.primary',
          entitySources: {
            emailProvider: 'resolver.email',
          },
        }),
      },
    ]);
  });

  it('falls back to generic clarification copy when the classifier omits a real summary', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const gateway = makeGatewayRecord({
      route: 'general_assistant',
      resolution: 'needs_clarification',
      summary: 'No classification summary provided.',
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Do the thing'),
        activeSkills: [],
      },
      {
        enabledManagedProviders: new Set(['gws', 'm365']),
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: () => undefined,
        toPendingActionEntities,
      },
    );

    expect(response?.content).toBe('I need a bit more detail before I can continue with that request.');
    expect(pendingActionInputs[0]).toMatchObject({
      prompt: 'I need a bit more detail before I can continue with that request.',
    });
    expect(pendingActionInputs[0]?.summary).toBe('No classification summary provided.');
  });

  it('rewrites correction turns against the last actionable request', () => {
    const gateway = makeGatewayRecord({
      turnRelation: 'correction',
      entities: {
        codingBackend: 'codex',
      },
    });

    expect(resolveIntentGatewayContent({
      gateway,
      currentContent: 'Use Codex instead.',
      pendingAction: null,
      priorHistory: [
        { role: 'assistant', content: 'Which coding backend should I use?' },
        { role: 'user', content: 'Please refactor src/chat-agent.ts to extract the gateway continuation helpers.' },
      ],
    })).toBe('Use codex for this request: Please refactor src/chat-agent.ts to extract the gateway continuation helpers.');
  });

  it('resumes workspace-switch pending actions once the target session is active', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'workspace_switch',
        prompt: 'Switch workspaces first.',
        targetSessionId: 'session-123',
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Implement the uplift in the current workspace.',
      },
    });

    expect(resolvePendingActionContinuationContent(
      'continue',
      pendingAction,
      'session-123',
    )).toBe('Implement the uplift in the current workspace.');
  });

  it('restores the last actionable request after retryable provider failures', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: 'retry',
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Check my unread email.',
      }),
      conversationKey: { agentId: 'assistant', userId: 'user-1', channel: 'web' },
      readLatestAssistantOutput: () => 'Please connect your provider and try again.',
    })).toBe('Check my unread email.');
  });

  it('restores the last actionable request after sandbox prerequisite failures are cleared', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: "I've started that Daytona Sandbox so try again with the same request",
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.',
      }),
      conversationKey: { agentId: 'assistant', userId: 'user-1', channel: 'web' },
      readLatestAssistantOutput: () => 'The remote execution failed. The Daytona Main sandbox is currently stopped and cannot accept commands until restarted.',
    })).toBe('In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.');
  });

  it('delegates affirmative workspace-switch replies to the attach handler', async () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'workspace_switch',
        prompt: 'Switch workspaces first.',
        targetSessionId: 'session-999',
      },
    });
    const handleCodeSessionAttach = vi.fn(async () => ({ content: 'Attached to workspace.' }));

    const response = await tryHandleWorkspaceSwitchContinuation({
      message: makeMessage('yes'),
      ctx: TEST_CONTEXT,
      pendingAction,
      handleCodeSessionAttach,
    });

    expect(handleCodeSessionAttach).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'yes' }),
      TEST_CONTEXT,
      'session-999',
    );
    expect(response).toEqual({ content: 'Attached to workspace.' });
  });

  it('switches the active pending action when the user confirms a replacement', async () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        prompt: 'Original blocked request.',
      },
      resume: {
        kind: 'direct_route',
        payload: { previous: true },
      },
    });
    const replacement = makePendingAction({
      blocker: {
        kind: 'clarification',
        prompt: 'Replacement blocked request.',
      },
      intent: {
        route: 'coding_task',
        operation: 'update',
        originalUserContent: 'Refactor the gateway helpers.',
      },
    });

    const response = await tryHandlePendingActionSwitchDecision({
      message: makeMessage('switch to the new one'),
      pendingAction,
      gateway: makeGatewayRecord({
        route: 'coding_task',
      }),
      activeSkills: [],
      surfaceUserId: 'user-1',
      surfaceChannel: 'web',
      surfaceId: 'web-guardian-chat',
      readPendingActionSwitchCandidatePayload: () => ({
        type: 'pending_action_switch_candidate',
        previousResume: pendingAction.resume,
        replacement: {
          status: replacement.status,
          transferPolicy: replacement.transferPolicy,
          blocker: replacement.blocker,
          intent: replacement.intent,
          resume: replacement.resume,
          expiresAt: replacement.expiresAt,
        },
      }),
      replacePendingAction: (_userId, _channel, _surfaceId, nextReplacement) => ({
        ...replacement,
        id: nextReplacement.id,
      }),
      updatePendingAction: () => pendingAction,
      buildImmediateResponseMetadata: () => ({ pendingAction: { id: 'pending-1' } }),
    });

    expect(response?.content).toBe('Switched the active blocked request.\n\nReplacement blocked request.');
    expect(response?.metadata).toMatchObject({
      pendingAction: { id: 'pending-1' },
      intentGateway: expect.any(Object),
    });
  });

  it('sanitizes placeholder switch prompts before echoing them back to the user', async () => {
    const pendingAction = makePendingAction();
    const replacement = makePendingAction({
      blocker: {
        kind: 'clarification',
        prompt: 'No classification summary provided.',
      },
      intent: {
        route: 'email_task',
        operation: 'read',
        originalUserContent: 'Check my email.',
      },
    });

    const response = await tryHandlePendingActionSwitchDecision({
      message: makeMessage('yes'),
      pendingAction,
      gateway: makeGatewayRecord({
        route: 'email_task',
      }),
      activeSkills: [],
      surfaceUserId: 'user-1',
      surfaceChannel: 'web',
      surfaceId: 'web-guardian-chat',
      readPendingActionSwitchCandidatePayload: () => ({
        type: 'pending_action_switch_candidate',
        replacement: {
          status: replacement.status,
          transferPolicy: replacement.transferPolicy,
          blocker: replacement.blocker,
          intent: replacement.intent,
          expiresAt: replacement.expiresAt,
        },
      }),
      replacePendingAction: () => replacement,
      updatePendingAction: () => pendingAction,
      buildImmediateResponseMetadata: () => undefined,
    });

    expect(response?.content).toBe(
      'Switched the active blocked request.\n\nI need a bit more detail before I can continue with that request.',
    );
  });

  it('normalizes pending action entities and only clears satisfied clarifications', () => {
    const rawEntities = {
      urls: ['https://example.test'],
      query: undefined,
    };
    const normalizedEntities = toPendingActionEntities(rawEntities);

    expect(normalizedEntities).toEqual({
      urls: ['https://example.test'],
    });
    expect(normalizedEntities?.urls).not.toBe(rawEntities.urls);

    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'email_provider',
      },
      intent: {
        route: 'email_task',
      },
    });

    expect(shouldClearPendingActionAfterTurn(
      makeGatewayRecord({
        route: 'email_task',
        turnRelation: 'follow_up',
        entities: {
          emailProvider: 'm365',
        },
      }).decision,
      pendingAction,
    )).toBe(true);

    expect(shouldClearPendingActionAfterTurn(
      makeGatewayRecord({
        route: 'email_task',
        turnRelation: 'follow_up',
        entities: {},
      }).decision,
      pendingAction,
    )).toBe(false);
  });
});
