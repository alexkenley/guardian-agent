import { describe, expect, it } from 'vitest';

import {
  isGenericPendingActionContinuationRequest,
  isWorkspaceSwitchPendingActionSatisfied,
} from './pending-action-resume.js';
import type { PendingActionRecord } from './pending-actions.js';

function makeWorkspaceSwitchPendingAction(targetSessionId: string): PendingActionRecord {
  return {
    id: 'pending-1',
    scope: {
      agentId: 'assistant',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    },
    status: 'pending',
    blocker: {
      kind: 'workspace_switch',
      prompt: 'Switch first.',
      targetSessionId,
      targetSessionLabel: 'Target workspace',
    },
    intent: {
      route: 'coding_task',
      operation: 'create',
      originalUserContent: 'Use Codex in Test Tactical Game App workspace to create a file.',
    },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
}

describe('pending-action-resume', () => {
  it('recognizes generic continuation replies', () => {
    expect(isGenericPendingActionContinuationRequest('Okay now do the previous request')).toBe(true);
    expect(isGenericPendingActionContinuationRequest('continue')).toBe(true);
    expect(isGenericPendingActionContinuationRequest('go ahead')).toBe(true);
    expect(isGenericPendingActionContinuationRequest('Check my email')).toBe(false);
  });

  it('only marks workspace-switch pending actions satisfied when the target session matches', () => {
    const pendingAction = makeWorkspaceSwitchPendingAction('session-123');
    expect(isWorkspaceSwitchPendingActionSatisfied(pendingAction, 'session-123')).toBe(true);
    expect(isWorkspaceSwitchPendingActionSatisfied(pendingAction, 'session-456')).toBe(false);
    expect(isWorkspaceSwitchPendingActionSatisfied(null, 'session-123')).toBe(false);
  });
});
