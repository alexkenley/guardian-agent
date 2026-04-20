import { describe, expect, it } from 'vitest';

describe('web chat pending action helpers', () => {
  it('hydrates the current pending action from the store only during passive chat sync', async () => {
    const { shouldHydratePendingActionFromStore } = await import('../../web/public/js/chat-pending-actions.js');

    expect(shouldHydratePendingActionFromStore(undefined, { source: 'hydrate' })).toBe(true);
    expect(shouldHydratePendingActionFromStore(undefined, { source: 'response' })).toBe(false);
  });

  it('does not hydrate from the store when a response already includes structured pending action metadata', async () => {
    const { shouldHydratePendingActionFromStore } = await import('../../web/public/js/chat-pending-actions.js');

    expect(shouldHydratePendingActionFromStore({
      pendingAction: {
        id: 'pending-clarification-1',
      },
    }, { source: 'hydrate' })).toBe(false);
  });

  it('allows non-approval active pending actions to be cleared from chat', async () => {
    const { canClearPendingActionFromChat } = await import('../../web/public/js/chat-pending-actions.js');

    expect(canClearPendingActionFromChat({
      id: 'pending-clarification-1',
      status: 'pending',
      blocker: { kind: 'clarification' },
    })).toBe(true);
  });

  it('does not allow approval pending actions to be cleared from chat', async () => {
    const { canClearPendingActionFromChat } = await import('../../web/public/js/chat-pending-actions.js');

    expect(canClearPendingActionFromChat({
      id: 'pending-approval-1',
      status: 'pending',
      blocker: { kind: 'approval' },
    })).toBe(false);
  });

  it('keeps synthetic blocked prompts dismissible after reload even when legacy status is absent', async () => {
    const { canClearPendingActionFromChat } = await import('../../web/public/js/chat-pending-actions.js');

    expect(canClearPendingActionFromChat(
      {
        id: 'pending-legacy-1',
        blocker: { kind: 'clarification' },
      },
      { syntheticPendingAction: true },
    )).toBe(true);
  });

  it('does not clear inactive non-synthetic pending actions from chat history', async () => {
    const { canClearPendingActionFromChat } = await import('../../web/public/js/chat-pending-actions.js');

    expect(canClearPendingActionFromChat({
      id: 'pending-completed-1',
      status: 'completed',
      blocker: { kind: 'clarification' },
    })).toBe(false);
  });
});
