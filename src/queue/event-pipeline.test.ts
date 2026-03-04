import { describe, it, expect, vi } from 'vitest';
import { EventBus, type AgentEvent } from './event-bus.js';
import {
  defaultEventClassifier,
  defaultEventPolicy,
  type ClassifiedEvent,
  type EventPolicyDecision,
} from './event-pipeline.js';

function makeEvent(type: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type,
    sourceAgentId: 'test',
    targetAgentId: '*',
    payload: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('defaultEventClassifier', () => {
  it('classifies user.* as chat', () => {
    expect(defaultEventClassifier(makeEvent('user.message'))).toBe('chat');
  });

  it('classifies chat.* as chat', () => {
    expect(defaultEventClassifier(makeEvent('chat.token'))).toBe('chat');
  });

  it('classifies agent.* as agent', () => {
    expect(defaultEventClassifier(makeEvent('agent.response'))).toBe('agent');
  });

  it('classifies guardian.* as security', () => {
    expect(defaultEventClassifier(makeEvent('guardian.denied'))).toBe('security');
  });

  it('classifies audit.* as security', () => {
    expect(defaultEventClassifier(makeEvent('audit.entry'))).toBe('security');
  });

  it('classifies system.* as system', () => {
    expect(defaultEventClassifier(makeEvent('system.startup'))).toBe('system');
  });

  it('classifies presence.* as presence', () => {
    expect(defaultEventClassifier(makeEvent('presence.online'))).toBe('presence');
  });

  it('classifies unknown prefixes as unknown', () => {
    expect(defaultEventClassifier(makeEvent('custom.something'))).toBe('unknown');
  });
});

describe('defaultEventPolicy', () => {
  it('returns log and forward, no alert or throttle', () => {
    const classified: ClassifiedEvent = {
      ...makeEvent('test'),
      category: 'chat',
      classifiedAt: Date.now(),
    };
    const decision = defaultEventPolicy(classified);
    expect(decision.shouldLog).toBe(true);
    expect(decision.shouldForward).toBe(true);
    expect(decision.shouldAlert).toBe(false);
    expect(decision.shouldThrottle).toBe(false);
  });
});

describe('EventBus.usePipeline', () => {
  it('events flow through classify→policy→execute', async () => {
    const bus = new EventBus();
    const handled: ClassifiedEvent[] = [];
    const decisions: EventPolicyDecision[] = [];

    bus.usePipeline(
      defaultEventClassifier,
      defaultEventPolicy,
      (event, decision) => {
        handled.push(event);
        decisions.push(decision);
      },
    );

    await bus.emit(makeEvent('user.message'));

    expect(handled).toHaveLength(1);
    expect(handled[0].category).toBe('chat');
    expect(handled[0].classifiedAt).toBeGreaterThan(0);
    expect(decisions[0].shouldLog).toBe(true);
  });

  it('shouldThrottle skips handler', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.usePipeline(
      defaultEventClassifier,
      () => ({
        shouldLog: true,
        shouldForward: true,
        shouldAlert: false,
        shouldThrottle: true,
      }),
      handler,
    );

    await bus.emit(makeEvent('user.message'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('multiple pipelines run independently', async () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.usePipeline(defaultEventClassifier, defaultEventPolicy, handler1);
    bus.usePipeline(defaultEventClassifier, defaultEventPolicy, handler2);

    await bus.emit(makeEvent('system.startup'));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes pipeline', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsub = bus.usePipeline(defaultEventClassifier, defaultEventPolicy, handler);
    unsub();

    await bus.emit(makeEvent('user.message'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not interfere with existing subscribe/emit', async () => {
    const bus = new EventBus();
    const regularHandler = vi.fn();
    const pipelineHandler = vi.fn();

    bus.subscribe('target-agent', regularHandler);
    bus.usePipeline(defaultEventClassifier, defaultEventPolicy, pipelineHandler);

    const event = makeEvent('user.message', { targetAgentId: 'target-agent' });
    await bus.emit(event);

    expect(regularHandler).toHaveBeenCalledTimes(1);
    expect(pipelineHandler).toHaveBeenCalledTimes(1);
  });

  it('removeAllHandlers clears pipelines too', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.usePipeline(defaultEventClassifier, defaultEventPolicy, handler);
    bus.removeAllHandlers();

    await bus.emit(makeEvent('user.message'));
    expect(handler).not.toHaveBeenCalled();
  });
});
