import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  type DirectScheduledEmailAutomationDeps,
  tryDirectScheduledEmailAutomation,
} from './direct-scheduled-email-automation.js';

function makeMessage(content: string): UserMessage {
  return {
    id: 'msg-1',
    userId: 'owner',
    channel: 'web',
    surfaceId: 'surface-1',
    timestamp: 1,
    content,
  };
}

function makeDeps(overrides?: Partial<DirectScheduledEmailAutomationDeps>): DirectScheduledEmailAutomationDeps {
  return {
    agentId: 'agent-1',
    tools: {
      isEnabled: () => true,
      executeModelTool: vi.fn(async () => ({ success: true })),
      getApprovalSummaries: vi.fn(() => new Map()),
    },
    conversationService: {
      getHistoryForContext: vi.fn(() => []),
    },
    setApprovalFollowUp: vi.fn(),
    getPendingApprovals: vi.fn(() => null),
    formatPendingApprovalPrompt: vi.fn(() => 'Approve it.'),
    setPendingApprovalActionForRequest: vi.fn(() => ({
      action: { id: 'pending-1' } as PendingActionRecord,
    })),
    buildPendingApprovalBlockedResponse: vi.fn((_, fallbackContent) => ({ content: fallbackContent })),
    ...overrides,
  };
}

describe('direct scheduled email automation', () => {
  it('creates a scheduled Gmail automation through the shared tool executor', async () => {
    const deps = makeDeps();
    const message = makeMessage(
      'Create a task to send an email to alex@example.com tomorrow at 12 pm with subject Status and body Everything is green.',
    );

    const result = await tryDirectScheduledEmailAutomation({
      message,
      ctx: { checkAction: vi.fn() } as unknown as AgentContext,
      userKey: 'owner:web',
      stateAgentId: 'agent-1',
    }, deps);

    expect(result).toBe('I created a one-shot email automation to alex@example.com. It will run on the next scheduled time.');
    expect(deps.tools?.executeModelTool).toHaveBeenCalledWith(
      'automation_save',
      expect.objectContaining({
        id: 'scheduled-email-to-alex-example-com',
        name: 'Scheduled Email to alex@example.com',
        task: expect.objectContaining({
          target: 'gws',
          args: expect.objectContaining({
            service: 'gmail',
            resource: 'users messages',
            method: 'send',
          }),
        }),
        schedule: expect.objectContaining({
          enabled: true,
          runOnce: true,
        }),
      }),
      expect.objectContaining({
        origin: 'assistant',
        agentId: 'agent-1',
        userId: 'owner',
        channel: 'web',
        requestId: 'msg-1',
      }),
    );
  });

  it('wraps scheduled email automation approvals in shared pending-action metadata', async () => {
    const deps = makeDeps({
      tools: {
        isEnabled: () => true,
        executeModelTool: vi.fn(async () => ({
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
        })),
        getApprovalSummaries: vi.fn(() => new Map([
          ['approval-1', { toolName: 'automation_save', argsPreview: 'scheduled email' }],
        ])),
      },
      getPendingApprovals: vi.fn(() => ({
        ids: ['approval-existing'],
        prompt: 'Existing approval.',
        hasPending: true,
      })),
    });
    const message = makeMessage(
      'Grant me an automation to send an email to alex@example.com at 11:03 PM. Every day, recurring. Subject is Status, body Everything is green.',
    );

    const result = await tryDirectScheduledEmailAutomation({
      message,
      ctx: { checkAction: vi.fn() } as unknown as AgentContext,
      userKey: 'owner:web',
      stateAgentId: 'agent-1',
    }, deps);

    expect(result).toEqual({ content: 'I prepared a recurring email automation to alex@example.com.\n\nApprove it.' });
    expect(deps.setApprovalFollowUp).toHaveBeenCalledWith('approval-1', {
      approved: 'I created the recurring email automation to alex@example.com.',
      denied: 'I did not create the scheduled email automation.',
    });
    expect(deps.setPendingApprovalActionForRequest).toHaveBeenCalledWith(
      'owner:web',
      'surface-1',
      expect.objectContaining({
        approvalIds: ['approval-existing', 'approval-1'],
        originalUserContent: message.content,
        route: 'automation_authoring',
        operation: 'schedule',
        summary: 'Creates a recurring scheduled email automation.',
      }),
    );
  });
});
