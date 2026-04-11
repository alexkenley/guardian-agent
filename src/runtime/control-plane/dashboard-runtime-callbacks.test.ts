import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../../config/types.js';
import { createDashboardRuntimeCallbacks } from './dashboard-runtime-callbacks.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createDispatchContext() {
  return {
    requestId: 'dispatch-ctx',
    sessionId: 'session-1',
    priority: 'high' as const,
    requestType: 'chat',
    runStep: vi.fn(async (_name: string, run: () => Promise<unknown> | unknown) => run()),
    markStep: vi.fn(),
    addNode: vi.fn(),
  };
}

function createHarness(
  overrides: Partial<Parameters<typeof createDashboardRuntimeCallbacks>[0]> = {},
): Parameters<typeof createDashboardRuntimeCallbacks>[0] {
  const configRef = { current: createConfig() };
  configRef.current.channels.web.defaultAgent = 'default-agent';
  const dispatchCtx = createDispatchContext();

  return {
    configRef,
    runtime: {
      auditLog: {
        addListener: vi.fn(() => () => undefined),
      },
      eventBus: {
        pending: 3,
        subscribeByType: vi.fn(),
        unsubscribeByType: vi.fn(),
      },
      watchdog: {
        check: vi.fn(() => [{ agentId: 'default-agent', state: 'ready' }]),
      },
      dispatchMessage: vi.fn(async () => ({ content: 'quick action reply', metadata: { ok: true } })),
    },
    securityActivityLog: {
      addListener: vi.fn(() => () => undefined),
    },
    runTimeline: {
      subscribe: vi.fn(() => () => undefined),
    },
    agentDashboard: {
      onAgents: vi.fn(() => [{
        id: 'default-agent',
        name: 'Default Agent',
        state: 'ready',
        capabilities: [],
        lastActivityMs: 10,
        consecutiveErrors: 0,
      }]),
    },
    dispatchDashboardMessage: vi.fn(async () => ({ content: 'ok', metadata: { responseSource: { locality: 'local' } } })),
    prepareIncomingDispatch: vi.fn(async () => ({
      requestId: 'prepared-1',
      decision: { agentId: 'prepared-agent', confidence: 'high', reason: 'prepared' },
      gateway: null,
      routedMessage: {
        content: 'prepared message',
        userId: 'prepared-user',
        channel: 'web',
      },
    })),
    identity: {
      resolveCanonicalUserId: vi.fn((_channel: string, userId: string) => `canonical:${userId}`),
    },
    analytics: {
      track: vi.fn(),
    },
    orchestrator: {
      dispatch: vi.fn(async (_input, handler) => handler(dispatchCtx)),
      cancelSession: vi.fn(),
    } as never,
    now: () => 1_700_000_000_000,
    createRequestId: () => 'req-1',
    ...overrides,
  };
}

describe('createDashboardRuntimeCallbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes SSE listeners and emits live runtime events', async () => {
    const auditListeners: Array<(event: unknown) => void> = [];
    const triageListeners: Array<(entry: unknown) => void> = [];
    const timelineListeners: Array<(detail: unknown) => void> = [];
    const unsubAudit = vi.fn();
    const unsubTriage = vi.fn();
    const unsubTimeline = vi.fn();
    let securityAlertListener: ((event: { payload: unknown }) => void) | null = null;
    const options = createHarness({
      runtime: {
        auditLog: {
          addListener: vi.fn((listener) => {
            auditListeners.push(listener);
            return unsubAudit;
          }),
        },
        eventBus: {
          pending: 7,
          subscribeByType: vi.fn((_type: string, listener: (event: { payload: unknown }) => void) => {
            securityAlertListener = listener;
          }),
          unsubscribeByType: vi.fn(),
        },
        watchdog: {
          check: vi.fn(() => ['watchdog']),
        },
        dispatchMessage: vi.fn(async () => ({ content: 'quick action reply', metadata: { ok: true } })),
      },
      securityActivityLog: {
        addListener: vi.fn((listener) => {
          triageListeners.push(listener);
          return unsubTriage;
        }),
      },
      runTimeline: {
        subscribe: vi.fn((listener) => {
          timelineListeners.push(listener);
          return unsubTimeline;
        }),
      },
    });
    options.configRef.current.assistant.notifications.destinations.web = true;
    const callbacks = createDashboardRuntimeCallbacks(options);
    const events: Array<{ type: string; data: unknown }> = [];

    const unsubscribe = callbacks.onSSESubscribe?.((event) => {
      events.push({ type: event.type, data: event.data });
    });

    auditListeners[0]?.({ id: 'audit-1' });
    triageListeners[0]?.({ id: 'triage-1' });
    timelineListeners[0]?.({ summary: { runId: 'run-1' } });
    securityAlertListener?.({ payload: { id: 'sec-1' } });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(events.map((event) => event.type)).toEqual([
      'audit',
      'security.triage',
      'run.timeline',
      'security.alert',
      'metrics',
      'metrics',
      'watchdog',
    ]);
    expect(events[4]).toEqual({
      type: 'metrics',
      data: {
        agents: [{
          id: 'default-agent',
          name: 'Default Agent',
          state: 'ready',
          capabilities: [],
          lastActivityMs: 10,
          consecutiveErrors: 0,
        }],
        eventBusPending: 7,
        timestamp: 1_700_000_000_000,
      },
    });
    expect(events[6]).toEqual({
      type: 'watchdog',
      data: {
        results: ['watchdog'],
        timestamp: 1_700_000_000_000,
      },
    });

    unsubscribe?.();
    expect(unsubAudit).toHaveBeenCalledOnce();
    expect(unsubTriage).toHaveBeenCalledOnce();
    expect(unsubTimeline).toHaveBeenCalledOnce();
    expect(options.runtime.eventBus.unsubscribeByType).toHaveBeenCalledWith('security:alert', expect.any(Function));
  });

  it('delegates dispatch and stream dispatch through the dashboard dispatcher', async () => {
    const dispatchDashboardMessage = vi
      .fn()
      .mockResolvedValueOnce({ content: 'dispatch reply', metadata: { step: 'direct' } })
      .mockResolvedValueOnce({ content: 'stream reply', metadata: { step: 'stream' } });
    const prepareIncomingDispatch = vi.fn(async () => ({
      requestId: 'prepared-1',
      decision: { agentId: 'prepared-agent', confidence: 'high', reason: 'prepared' },
      gateway: { mode: 'primary', available: true, model: 'test', latencyMs: 1, decision: { route: 'chat', confidence: 'high', operation: 'answer', summary: 'ready', turnRelation: 'new_request', resolution: 'ready', missingFields: [], entities: {} } },
      routedMessage: {
        content: 'prepared message',
        userId: 'prepared-user',
        channel: 'web',
      },
    }));
    const options = createHarness({
      dispatchDashboardMessage,
      prepareIncomingDispatch,
    });
    const callbacks = createDashboardRuntimeCallbacks(options);
    const sseEvents: Array<{ type: string; data: unknown }> = [];

    await expect(callbacks.onDispatch?.(
      'agent-1',
      { content: 'hello', userId: 'web-user', channel: 'web' },
      undefined,
      undefined,
      null,
    )).resolves.toEqual({ content: 'dispatch reply', metadata: { step: 'direct' } });
    expect(dispatchDashboardMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentId: 'agent-1',
      msg: { content: 'hello', userId: 'web-user', channel: 'web' },
    }));

    await expect(callbacks.onStreamDispatch?.(
      undefined,
      { content: 'stream this', userId: 'web-user', channel: 'web' },
      (event) => sseEvents.push({ type: event.type, data: event.data }),
    )).resolves.toEqual({
      requestId: 'req-1',
      runId: 'req-1',
      content: 'stream reply',
      metadata: { step: 'stream' },
    });
    expect(prepareIncomingDispatch).toHaveBeenCalledWith('default-agent', { content: 'stream this', userId: 'web-user', channel: 'web' });
    expect(dispatchDashboardMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentId: 'prepared-agent',
      msg: { content: 'prepared message', userId: 'prepared-user', channel: 'web' },
      options: {
        priority: 'high',
        requestType: 'chat',
        requestId: 'req-1',
      },
    }));
    expect(sseEvents).toEqual([
      {
        type: 'chat.thinking',
        data: { requestId: 'req-1', runId: 'req-1' },
      },
      {
        type: 'chat.done',
        data: { requestId: 'req-1', runId: 'req-1', content: 'stream reply', metadata: { step: 'stream' } },
      },
    ]);
  });

  it('still prepares routing metadata for explicit-agent stream dispatches', async () => {
    const dispatchDashboardMessage = vi
      .fn()
      .mockResolvedValueOnce({ content: 'stream reply', metadata: { step: 'stream' } });
    const prepareIncomingDispatch = vi.fn(async () => ({
      requestId: 'prepared-2',
      decision: { agentId: 'prepared-agent', confidence: 'high', reason: 'prepared' },
      gateway: {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 2,
        decision: {
          route: 'personal_assistant_task',
          confidence: 'high',
          operation: 'create',
          summary: 'Create a contact.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'person' },
        },
      },
      routedMessage: {
        content: 'Create a contact for Angela Lee',
        userId: 'prepared-user',
        channel: 'web',
        metadata: {
          __guardian_execution_profile: {
            providerName: 'ollama-cloud-direct',
          },
        },
      },
    }));
    const options = createHarness({
      dispatchDashboardMessage,
      prepareIncomingDispatch,
    });
    const callbacks = createDashboardRuntimeCallbacks(options);

    await expect(callbacks.onStreamDispatch?.(
      'default-agent',
      { content: 'Create a contact for Angela Lee', userId: 'web-user', channel: 'web' },
      () => undefined,
    )).resolves.toEqual({
      requestId: 'req-1',
      runId: 'req-1',
      content: 'stream reply',
      metadata: { step: 'stream' },
    });

    expect(prepareIncomingDispatch).toHaveBeenCalledWith(undefined, {
      content: 'Create a contact for Angela Lee',
      userId: 'web-user',
      channel: 'web',
    });
    expect(dispatchDashboardMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'default-agent',
      precomputedIntentGateway: expect.objectContaining({
        decision: expect.objectContaining({
          route: 'personal_assistant_task',
        }),
      }),
      msg: expect.objectContaining({
        metadata: expect.objectContaining({
          __guardian_execution_profile: expect.objectContaining({
            providerName: 'ollama-cloud-direct',
          }),
        }),
      }),
    }));
  });

  it('drops an unresolved reserved web default alias before stream dispatch fallback', async () => {
    const dispatchDashboardMessage = vi.fn(async () => ({ content: 'stream reply', metadata: { step: 'stream' } }));
    const prepareIncomingDispatch = vi.fn(async () => ({
      requestId: 'prepared-3',
      decision: { agentId: 'prepared-agent', confidence: 'high', reason: 'prepared' },
      gateway: null,
      routedMessage: {
        content: 'prepared message',
        userId: 'prepared-user',
        channel: 'web',
      },
    }));
    const options = createHarness({
      dispatchDashboardMessage,
      prepareIncomingDispatch,
      resolveConfiguredAgentId: (agentId?: string) => agentId === 'external' ? undefined : agentId,
    });
    options.configRef.current.channels.web.defaultAgent = 'external';
    const callbacks = createDashboardRuntimeCallbacks(options);

    await expect(callbacks.onStreamDispatch?.(
      undefined,
      { content: 'hello', userId: 'web-user', channel: 'web' },
      () => undefined,
    )).resolves.toEqual({
      requestId: 'req-1',
      runId: 'req-1',
      content: 'stream reply',
      metadata: { step: 'stream' },
    });

    expect(prepareIncomingDispatch).toHaveBeenCalledWith(undefined, {
      content: 'hello',
      userId: 'web-user',
      channel: 'web',
    });
    expect(dispatchDashboardMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'prepared-agent',
    }));
  });

  it('supports canceling an active stream dispatch and suppresses late done events', async () => {
    let resolveDispatch: ((value: { content: string; metadata?: Record<string, unknown> }) => void) | null = null;
    const dispatchDashboardMessage = vi.fn(() => new Promise<{ content: string; metadata?: Record<string, unknown> }>((resolve) => {
      resolveDispatch = resolve;
    }));
    const options = createHarness({
      dispatchDashboardMessage,
    });
    const callbacks = createDashboardRuntimeCallbacks(options);
    const sseEvents: Array<{ type: string; data: unknown }> = [];

    const streamPromise = callbacks.onStreamDispatch?.(
      undefined,
      { content: 'stream this', userId: 'web-user', channel: 'web' },
      (event) => sseEvents.push({ type: event.type, data: event.data }),
    );

    await Promise.resolve();

    await expect(callbacks.onStreamCancel?.({
      requestId: 'req-1',
      userId: 'web-user',
      channel: 'web',
    })).resolves.toEqual({
      success: true,
      canceled: true,
      message: 'Request canceled by operator.',
      requestId: 'req-1',
      runId: 'req-1',
      errorCode: 'REQUEST_CANCELED',
    });

    resolveDispatch?.({ content: 'late reply', metadata: { step: 'stream' } });

    await expect(streamPromise).resolves.toEqual({
      requestId: 'req-1',
      runId: 'req-1',
      content: '',
      error: 'Request canceled by operator.',
      errorCode: 'REQUEST_CANCELED',
    });

    expect(sseEvents).toEqual([
      {
        type: 'chat.thinking',
        data: { requestId: 'req-1', runId: 'req-1' },
      },
      {
        type: 'chat.error',
        data: {
          requestId: 'req-1',
          runId: 'req-1',
          error: 'Request canceled by operator.',
          errorCode: 'REQUEST_CANCELED',
        },
      },
    ]);
  });

  it('returns a non-active result when canceling an unknown stream request', async () => {
    const options = createHarness();
    const callbacks = createDashboardRuntimeCallbacks(options);

    await expect(callbacks.onStreamCancel?.({
      requestId: 'missing-request',
      userId: 'web-user',
      channel: 'web',
    })).resolves.toEqual({
      success: false,
      canceled: false,
      message: "Request 'missing-request' is no longer active.",
      requestId: 'missing-request',
      runId: 'missing-request',
      errorCode: 'REQUEST_NOT_ACTIVE',
    });
  });

  it('runs quick actions through orchestrator dispatch and runtime message dispatch', async () => {
    const dispatchMessage = vi.fn(async () => ({ content: 'Draft ready.', metadata: { model: 'test' } }));
    const options = createHarness({
      runtime: {
        auditLog: {
          addListener: vi.fn(() => () => undefined),
        },
        eventBus: {
          pending: 3,
          subscribeByType: vi.fn(),
          unsubscribeByType: vi.fn(),
        },
        watchdog: {
          check: vi.fn(() => [{ agentId: 'default-agent', state: 'ready' }]),
        },
        dispatchMessage,
      },
    });
    const callbacks = createDashboardRuntimeCallbacks(options);

    await expect(callbacks.onQuickActionRun?.({
      actionId: 'email',
      details: 'Send an update to the team.',
      agentId: 'default-agent',
      userId: 'web-user',
      channel: 'web',
    })).resolves.toEqual({
      content: 'Draft ready.',
      metadata: { model: 'test' },
    });

    expect(options.analytics.track).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quick_action_triggered',
      channel: 'web',
      canonicalUserId: 'canonical:web-user',
      channelUserId: 'web-user',
      agentId: 'default-agent',
      metadata: { actionId: 'email' },
    }));
    expect(options.orchestrator.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'default-agent',
      userId: 'canonical:web-user',
      channel: 'web',
      requestType: 'quick_action',
    }), expect.any(Function));
    expect(dispatchMessage).toHaveBeenCalledWith('default-agent', expect.objectContaining({
      id: 'req-1',
      userId: 'canonical:web-user',
      channel: 'web',
      content: expect.stringContaining('Draft a concise, professional email'),
      timestamp: 1_700_000_000_000,
    }));
  });
});
