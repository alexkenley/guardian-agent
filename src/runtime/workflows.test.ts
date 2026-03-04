import { describe, it, expect } from 'vitest';
import { buildSessionKey, planDispatch, selectNextPending } from './workflows.js';

describe('buildSessionKey', () => {
  it('concatenates channel:userId:agentId', () => {
    expect(buildSessionKey('web', 'user1', 'chat')).toBe('web:user1:chat');
  });
});

describe('planDispatch', () => {
  it('derives all fields from input', () => {
    const plan = planDispatch(
      { agentId: 'a1', userId: 'u1', channel: 'web', content: 'hello', priority: 'high', requestType: 'message' },
      1000,
      42,
      180,
    );
    expect(plan.sessionKey).toBe('web:u1:a1');
    expect(plan.requestId).toBe('req-1000-42');
    expect(plan.priority).toBe('high');
    expect(plan.requestType).toBe('message');
    expect(plan.messagePreview).toBe('hello');
  });

  it('defaults priority to normal', () => {
    const plan = planDispatch(
      { agentId: 'a1', userId: 'u1', channel: 'cli', content: 'test' },
      2000,
      1,
      180,
    );
    expect(plan.priority).toBe('normal');
  });

  it('truncates long messages', () => {
    const long = 'a'.repeat(200);
    const plan = planDispatch(
      { agentId: 'a1', userId: 'u1', channel: 'web', content: long },
      1000,
      1,
      50,
    );
    expect(plan.messagePreview!.length).toBe(50);
    expect(plan.messagePreview!.endsWith('…')).toBe(true);
  });
});

describe('selectNextPending', () => {
  it('returns -1 for empty queue', () => {
    expect(selectNextPending([])).toBe(-1);
  });

  it('selects highest priority', () => {
    const queue = [
      { order: 1, priority: 'low' as const },
      { order: 2, priority: 'high' as const },
      { order: 3, priority: 'normal' as const },
    ];
    expect(selectNextPending(queue)).toBe(1);
  });

  it('selects earliest order on tie', () => {
    const queue = [
      { order: 3, priority: 'normal' as const },
      { order: 1, priority: 'normal' as const },
      { order: 2, priority: 'normal' as const },
    ];
    expect(selectNextPending(queue)).toBe(1);
  });

  it('prefers priority over order', () => {
    const queue = [
      { order: 1, priority: 'low' as const },
      { order: 5, priority: 'high' as const },
    ];
    expect(selectNextPending(queue)).toBe(1);
  });
});
