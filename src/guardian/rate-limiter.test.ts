import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter.js';
import type { AgentAction } from './guardian.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAction(agentId: string = 'test', userId?: string): AgentAction {
    return {
      type: 'message_dispatch',
      agentId,
      capabilities: [],
      params: userId ? { userId } : {},
    };
  }

  function makeChannelAction(agentId: string, userId: string, channel: string): AgentAction {
    return {
      type: 'message_dispatch',
      agentId,
      capabilities: [],
      params: { userId, channel },
    };
  }

  it('should pass through non-message actions', () => {
    const limiter = new RateLimiter();
    const action: AgentAction = {
      type: 'read_file',
      agentId: 'test',
      capabilities: [],
      params: {},
    };

    expect(limiter.check(action)).toBeNull();
  });

  it('should allow requests under burst limit', () => {
    const limiter = new RateLimiter({ burstAllowed: 5, maxPerMinute: 30, maxPerHour: 500 });

    for (let i = 0; i < 4; i++) {
      expect(limiter.check(makeAction())).toBeNull();
    }
  });

  it('should deny when burst limit exceeded', () => {
    const limiter = new RateLimiter({ burstAllowed: 3, maxPerMinute: 30, maxPerHour: 500 });

    // 3 requests within 10s
    for (let i = 0; i < 3; i++) {
      expect(limiter.check(makeAction())).toBeNull();
    }

    // 4th request should be denied (burst)
    const result = limiter.check(makeAction());
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.reason).toContain('burst exceeded');
  });

  it('should allow requests after burst window passes', () => {
    const limiter = new RateLimiter({ burstAllowed: 2, maxPerMinute: 30, maxPerHour: 500 });

    // 2 requests at t=0
    expect(limiter.check(makeAction())).toBeNull();
    expect(limiter.check(makeAction())).toBeNull();

    // 3rd blocked at t=0
    expect(limiter.check(makeAction())!.allowed).toBe(false);

    // Advance 11 seconds — beyond burst window
    vi.advanceTimersByTime(11_000);

    // Should be allowed now
    expect(limiter.check(makeAction())).toBeNull();
  });

  it('should deny when per-minute limit exceeded', () => {
    const limiter = new RateLimiter({ burstAllowed: 100, maxPerMinute: 5, maxPerHour: 500 });

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(3_000); // Space out to avoid burst limit
      expect(limiter.check(makeAction())).toBeNull();
    }

    vi.advanceTimersByTime(3_000);
    const result = limiter.check(makeAction());
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.reason).toContain('per-minute exceeded');
  });

  it('should deny when per-hour limit exceeded', () => {
    const limiter = new RateLimiter({ burstAllowed: 100, maxPerMinute: 100, maxPerHour: 5 });

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(61_000); // Space beyond minute window
      expect(limiter.check(makeAction())).toBeNull();
    }

    vi.advanceTimersByTime(61_000);
    const result = limiter.check(makeAction());
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.reason).toContain('per-hour exceeded');
  });

  it('should track agents independently', () => {
    const limiter = new RateLimiter({ burstAllowed: 2, maxPerMinute: 30, maxPerHour: 500 });

    // Agent A: 2 requests
    expect(limiter.check(makeAction('a'))).toBeNull();
    expect(limiter.check(makeAction('a'))).toBeNull();
    expect(limiter.check(makeAction('a'))!.allowed).toBe(false);

    // Agent B: should still be fine
    expect(limiter.check(makeAction('b'))).toBeNull();
    expect(limiter.check(makeAction('b'))).toBeNull();
  });

  it('should reset state for specific agent', () => {
    const limiter = new RateLimiter({ burstAllowed: 2, maxPerMinute: 30, maxPerHour: 500 });

    expect(limiter.check(makeAction())).toBeNull();
    expect(limiter.check(makeAction())).toBeNull();
    expect(limiter.check(makeAction())!.allowed).toBe(false);

    limiter.reset('test');
    expect(limiter.check(makeAction())).toBeNull();
  });

  it('should reset all state', () => {
    const limiter = new RateLimiter({ burstAllowed: 2, maxPerMinute: 30, maxPerHour: 500 });

    expect(limiter.check(makeAction('a'))).toBeNull();
    expect(limiter.check(makeAction('a'))).toBeNull();
    expect(limiter.check(makeAction('b'))).toBeNull();
    expect(limiter.check(makeAction('b'))).toBeNull();

    limiter.resetAll();

    expect(limiter.check(makeAction('a'))).toBeNull();
    expect(limiter.check(makeAction('b'))).toBeNull();
  });

  it('should enforce per-user limits across agents', () => {
    const limiter = new RateLimiter({
      burstAllowed: 10,
      maxPerMinute: 100,
      maxPerHour: 1000,
      maxPerMinutePerUser: 2,
      maxPerHourPerUser: 10,
    });

    expect(limiter.check(makeAction('agent-a', 'user-1'))).toBeNull();
    expect(limiter.check(makeAction('agent-b', 'user-1'))).toBeNull();
    const result = limiter.check(makeAction('agent-c', 'user-1'));
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.reason).toContain("user 'user-1'");
  });

  it('should enforce global limits', () => {
    const limiter = new RateLimiter({
      burstAllowed: 10,
      maxPerMinute: 100,
      maxPerHour: 1000,
      maxGlobalPerMinute: 2,
      maxGlobalPerHour: 20,
    });

    expect(limiter.check(makeAction('a', 'u1'))).toBeNull();
    expect(limiter.check(makeAction('b', 'u2'))).toBeNull();
    const result = limiter.check(makeAction('c', 'u3'));
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.reason).toContain('global');
  });

  it('does not let scheduled traffic consume the interactive per-user bucket', () => {
    const limiter = new RateLimiter({
      burstAllowed: 10,
      maxPerMinute: 100,
      maxPerHour: 1000,
      maxPerMinutePerUser: 1,
      maxPerHourPerUser: 10,
    });

    expect(limiter.check(makeChannelAction('security-triage', 'owner', 'scheduled'))).toBeNull();
    expect(limiter.check(makeChannelAction('external', 'owner', 'web'))).toBeNull();
  });
});
