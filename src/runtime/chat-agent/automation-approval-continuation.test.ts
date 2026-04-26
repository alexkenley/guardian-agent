import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  continueAutomationAfterApproval,
  InMemoryAutomationApprovalContinuationStore,
  resolveAutomationApprovalDecisionContinuation,
} from './automation-approval-continuation.js';

const TEST_CONTEXT: AgentContext = {
  agentId: 'chat',
  emit: async () => undefined,
  checkAction: () => undefined,
  capabilities: [],
};

function makeMessage(): UserMessage {
  return {
    id: 'msg-1',
    userId: 'owner',
    channel: 'web',
    surfaceId: 'web-guardian-chat',
    content: 'Create a briefing automation.',
    timestamp: 1,
  };
}

describe('automation approval continuation', () => {
  it('resumes stored automation authoring after the final approval resolves', async () => {
    const continuations = new InMemoryAutomationApprovalContinuationStore();
    continuations.set('owner:web', makeMessage(), TEST_CONTEXT, ['approval-1']);
    const runAutomationAuthoring = vi.fn(async () => ({ content: 'Automation created.' }));

    const result = await continueAutomationAfterApproval({
      approvalId: 'approval-1',
      decision: 'approved',
      continuations,
      runAutomationAuthoring,
    });

    expect(result).toEqual({ content: 'Automation created.' });
    expect(runAutomationAuthoring).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-1' }),
      TEST_CONTEXT,
      'owner:web',
      { assumeAuthoring: true },
    );
    expect(continuations.hasApprovalId('approval-1')).toBe(false);
  });

  it('updates partial automation continuations from approval orchestration decisions', async () => {
    const continuations = new InMemoryAutomationApprovalContinuationStore();
    const message = makeMessage();
    continuations.set('owner:web', message, TEST_CONTEXT, ['approval-1', 'approval-2']);

    const first = await resolveAutomationApprovalDecisionContinuation({
      userKey: 'owner:web',
      message,
      ctx: TEST_CONTEXT,
      decision: 'approved',
      targetIds: ['approval-1'],
      approvedIds: new Set(['approval-1']),
      failedIds: new Set(),
      continuations,
      tools: { listPendingApprovalIdsForUser: vi.fn(() => ['approval-2']) },
      runAutomationAuthoring: vi.fn(async () => ({ content: 'unexpected' })),
    });

    expect(first).toBeNull();
    expect(continuations.hasApprovalId('approval-1')).toBe(false);
    expect(continuations.hasApprovalId('approval-2')).toBe(true);

    const runAutomationAuthoring = vi.fn(async () => ({ content: 'Automation created.' }));
    const second = await resolveAutomationApprovalDecisionContinuation({
      userKey: 'owner:web',
      message,
      ctx: TEST_CONTEXT,
      decision: 'approved',
      targetIds: ['approval-2'],
      approvedIds: new Set(['approval-2']),
      failedIds: new Set(),
      continuations,
      tools: { listPendingApprovalIdsForUser: vi.fn(() => []) },
      runAutomationAuthoring,
    });

    expect(second).toEqual({ content: 'Automation created.' });
    expect(runAutomationAuthoring).toHaveBeenCalledOnce();
    expect(continuations.hasApprovalId('approval-2')).toBe(false);
  });
});
