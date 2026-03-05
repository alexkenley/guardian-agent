import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from './event-bus.js';
import type { AgentEvent } from './event-bus.js';

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: 'test',
    sourceAgentId: 'source',
    targetAgentId: 'target',
    payload: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('should start with 0 pending', () => {
    expect(bus.pending).toBe(0);
  });

  describe('immediate dispatch', () => {
    it('should deliver events immediately to target handlers', async () => {
      const received: AgentEvent[] = [];
      bus.subscribe('agent-a', (e) => { received.push(e); });

      await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));

      expect(received.length).toBe(1);
      expect(received[0].type).toBe('test');
    });

    it('should not deliver to non-target agents', async () => {
      const received: AgentEvent[] = [];
      bus.subscribe('agent-b', (e) => { received.push(e); });

      await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));

      expect(received.length).toBe(0);
    });

    it('should handle async handlers', async () => {
      const received: AgentEvent[] = [];
      bus.subscribe('agent-a', async (e) => {
        await new Promise(r => setTimeout(r, 1));
        received.push(e);
      });

      await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));

      expect(received.length).toBe(1);
    });
  });

  describe('broadcast delivery', () => {
    it('should deliver broadcast events to all handlers', async () => {
      const receivedA: AgentEvent[] = [];
      const receivedB: AgentEvent[] = [];
      bus.subscribe('agent-a', (e) => { receivedA.push(e); });
      bus.subscribe('agent-b', (e) => { receivedB.push(e); });

      await bus.emit(makeEvent({ targetAgentId: '*' }));

      expect(receivedA.length).toBe(1);
      expect(receivedB.length).toBe(1);
    });

    it('should deliver to broadcast handlers', async () => {
      const received: AgentEvent[] = [];
      bus.onBroadcast((e) => { received.push(e); });

      await bus.emit(makeEvent({ targetAgentId: '*' }));

      expect(received.length).toBe(1);
    });
  });

  describe('type-based subscriptions', () => {
    it('should deliver to type handlers regardless of target', async () => {
      const received: AgentEvent[] = [];
      bus.subscribeByType('user.message', (e) => { received.push(e); });

      await bus.emit(makeEvent({ type: 'user.message', targetAgentId: 'agent-a' }));

      expect(received.length).toBe(1);
    });

    it('should not deliver mismatched types', async () => {
      const received: AgentEvent[] = [];
      bus.subscribeByType('user.message', (e) => { received.push(e); });

      await bus.emit(makeEvent({ type: 'agent.response', targetAgentId: 'agent-a' }));

      expect(received.length).toBe(0);
    });
  });

  describe('max depth', () => {
    it('should reject events when max depth exceeded', async () => {
      const bus = new EventBus(1);
      // We need a handler that holds the event in flight
      let resolve: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      bus.subscribe('agent-a', async () => { await promise; });

      // First emit is in-flight (handler is awaiting)
      const emit1 = bus.emit(makeEvent({ targetAgentId: 'agent-a' }));

      // Second should be rejected while first is pending
      const result = await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));
      expect(result).toBe(false);

      resolve!();
      await emit1;
    });
  });

  describe('source validation', () => {
    it('should reject emits when source validator denies event', async () => {
      const guardedBus = new EventBus({
        sourceValidator: (event) => event.sourceAgentId === 'system',
      });
      const received: AgentEvent[] = [];
      guardedBus.subscribe('target', (event) => { received.push(event); });

      const denied = await guardedBus.emit(makeEvent({
        sourceAgentId: 'attacker',
        targetAgentId: 'target',
      }));
      expect(denied).toBe(false);
      expect(received.length).toBe(0);

      const allowed = await guardedBus.emit(makeEvent({
        sourceAgentId: 'system',
        targetAgentId: 'target',
      }));
      expect(allowed).toBe(true);
      expect(received.length).toBe(1);
    });
  });

  describe('unsubscribe', () => {
    it('should stop delivering after unsubscribe', async () => {
      const received: AgentEvent[] = [];
      const handler = (e: AgentEvent) => { received.push(e); };

      bus.subscribe('agent-a', handler);
      await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));
      expect(received.length).toBe(1);

      bus.unsubscribe('agent-a', handler);
      await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));
      expect(received.length).toBe(1); // no new events
    });

    it('should unsubscribe type handlers', async () => {
      const received: AgentEvent[] = [];
      const handler = (e: AgentEvent) => { received.push(e); };

      bus.subscribeByType('test', handler);
      await bus.emit(makeEvent());
      expect(received.length).toBe(1);

      bus.unsubscribeByType('test', handler);
      await bus.emit(makeEvent());
      expect(received.length).toBe(1);
    });
  });

  describe('removeAllHandlers', () => {
    it('should remove all handlers', async () => {
      const received: AgentEvent[] = [];
      bus.subscribe('agent-a', (e) => { received.push(e); });
      bus.onBroadcast((e) => { received.push(e); });
      bus.subscribeByType('test', (e) => { received.push(e); });

      bus.removeAllHandlers();

      await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));
      await bus.emit(makeEvent({ targetAgentId: '*' }));

      expect(received.length).toBe(0);
    });
  });

  describe('Fix #7: removeHandlersForAgent', () => {
    it('should remove all handlers for a specific agent', async () => {
      const receivedA: AgentEvent[] = [];
      const receivedB: AgentEvent[] = [];

      bus.subscribe('agent-a', (e) => { receivedA.push(e); });
      bus.subscribe('agent-a', (e) => { receivedA.push(e); }); // second handler
      bus.subscribe('agent-b', (e) => { receivedB.push(e); });

      bus.removeHandlersForAgent('agent-a');

      await bus.emit(makeEvent({ targetAgentId: 'agent-a' }));
      await bus.emit(makeEvent({ targetAgentId: 'agent-b' }));

      // agent-a handlers removed, agent-b still works
      expect(receivedA.length).toBe(0);
      expect(receivedB.length).toBe(1);
    });

    it('should prevent stale closure-based handlers after unregister', async () => {
      // This test verifies that using removeHandlersForAgent instead of
      // unsubscribe(agentId, differentClosure) actually removes handlers
      const received: AgentEvent[] = [];

      // Subscribe with a closure (like Runtime does)
      const handler = (e: AgentEvent) => { received.push(e); };
      bus.subscribe('agent-x', handler);

      // Verify it receives events
      await bus.emit(makeEvent({ targetAgentId: 'agent-x' }));
      expect(received.length).toBe(1);

      // Remove all handlers (like unregisterAgent does)
      bus.removeHandlersForAgent('agent-x');

      // Re-subscribe with new handler (like re-register would)
      const received2: AgentEvent[] = [];
      bus.subscribe('agent-x', (e) => { received2.push(e); });

      await bus.emit(makeEvent({ targetAgentId: 'agent-x' }));

      // Only new handler should receive, not the old stale one
      expect(received.length).toBe(1); // no new events on old handler
      expect(received2.length).toBe(1); // new handler works
    });

    it('should be safe to call on non-existent agent', () => {
      // Should not throw
      bus.removeHandlersForAgent('nonexistent');
    });
  });
});
