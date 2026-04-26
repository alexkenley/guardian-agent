import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  tryDirectAutomationAuthoring,
  tryDirectAutomationControl,
  type DirectAutomationDeps,
} from './direct-automation.js';

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
    route: 'automation_control',
    confidence: 'high',
    operation: 'run',
    summary: 'Run the automation.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'tool_orchestration',
    preferredTier: 'local',
    requiresRepoGrounding: false,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'tool_loop',
    entities: {},
    ...overrides,
  };
}

function makePendingAction(prompt: string): PendingActionRecord {
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
      prompt,
    },
    intent: {
      route: 'automation_control',
      operation: 'run',
      originalUserContent: 'Run my automation.',
    },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
}

function makeDeps(overrides: Partial<DirectAutomationDeps> = {}): DirectAutomationDeps {
  return {
    agentId: 'assistant',
    tools: {
      isEnabled: () => true,
      getPolicy: () => ({ sandbox: { allowedPaths: ['/workspace'] } }),
      preflightTools: async () => [],
      executeModelTool: async () => ({ success: true }),
      getApprovalSummaries: () => new Map(),
    } as DirectAutomationDeps['tools'],
    setApprovalFollowUp: () => undefined,
    formatPendingApprovalPrompt: (ids) => `Approve: ${ids.join(', ')}`,
    parsePendingActionUserKey: () => ({ userId: 'user-1', channel: 'web' }),
    setClarificationPendingAction: () => ({ action: makePendingAction('Which automation?') }),
    setPendingApprovalActionForRequest: () => ({ action: makePendingAction('Approve this automation.') }),
    setChatContinuationGraphPendingApprovalActionForRequest: () => ({ action: makePendingAction('Approve this automation.') }),
    buildPendingApprovalBlockedResponse: (_result, fallbackContent) => ({ content: fallbackContent }),
    ...overrides,
  };
}

describe('direct-automation', () => {
  it('turns automation-control clarification metadata into a shared pending action', async () => {
    const decision = makeDecision({
      route: 'automation_control',
      operation: 'update',
      resolution: 'needs_clarification',
      missingFields: ['automation_name'],
      provenance: {
        route: 'classifier.primary',
        operation: 'classifier.primary',
        entities: {
          automationName: 'resolver.automation',
        },
      },
      entities: {
        automationName: 'Daily Brief',
      },
    });
    let capturedClarificationInput: Record<string, unknown> | null = null;

    const response = await tryDirectAutomationControl(
      {
        message: makeMessage('Disable the automation'),
        ctx: TEST_CONTEXT,
        userKey: 'user-1:web',
        intentDecision: decision,
      },
      makeDeps({
        runAutomationControlPreRoute: async () => ({
          content: 'Which automation do you want to update?',
          metadata: {
            clarification: {
              blockerKind: 'clarification',
              field: 'automation_name',
              prompt: 'Which automation do you want to update?',
            },
            source: 'prerouter',
          },
        }),
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          capturedClarificationInput = input as unknown as Record<string, unknown>;
          return { action: makePendingAction('Which automation do you want to update?') };
        },
      }),
    );

    expect(capturedClarificationInput).toMatchObject({
      field: 'automation_name',
      provenance: decision.provenance,
      entities: {
        automationName: 'Daily Brief',
      },
    });
    expect(response).toMatchObject({
      content: 'Which automation do you want to update?',
      metadata: {
        source: 'prerouter',
        pendingAction: expect.any(Object),
      },
    });
    expect(response?.metadata).not.toHaveProperty('clarification');
  });

  it('wraps automation-authoring approvals in shared pending-action resume state', async () => {
    let capturedPendingApprovalInput: Record<string, unknown> | null = null;

    const response = await tryDirectAutomationAuthoring(
      {
        message: makeMessage('Create a daily briefing automation'),
        ctx: TEST_CONTEXT,
        userKey: 'user-1:web',
        options: {
          intentDecision: makeDecision({
            route: 'automation_authoring',
            operation: 'create',
            summary: 'Creates an automation.',
            provenance: {
              route: 'classifier.primary',
              operation: 'classifier.primary',
            },
          }),
        },
      },
      makeDeps({
        runAutomationPreRoute: async (deps) => {
          deps.trackPendingApproval('approval-1');
          return {
            content: 'Prepared the automation.',
            metadata: {
              resumeAutomationAfterApprovals: true,
            },
          };
        },
        setChatContinuationGraphPendingApprovalActionForRequest: (_userKey, _surfaceId, input) => {
          capturedPendingApprovalInput = input as unknown as Record<string, unknown>;
          return { action: makePendingAction('Approve this automation.') };
        },
        buildPendingApprovalBlockedResponse: () => ({
          content: 'Approval required.',
          metadata: { pendingAction: { id: 'pending-1' } },
        }),
      }),
    );

    expect(capturedPendingApprovalInput).toMatchObject({
      approvalIds: ['approval-1'],
      route: 'automation_authoring',
      operation: 'create',
      provenance: {
        route: 'classifier.primary',
        operation: 'classifier.primary',
      },
      continuation: {
        type: 'automation_authoring',
        originalUserContent: 'Create a daily briefing automation',
        allowRemediation: true,
      },
    });
    expect(response).toEqual({
      content: 'Approval required.',
      metadata: {
        pendingAction: { id: 'pending-1' },
        resumeAutomationAfterApprovals: true,
      },
    });
  });
});
