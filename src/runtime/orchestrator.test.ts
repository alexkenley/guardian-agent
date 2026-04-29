import { describe, expect, it } from 'vitest';
import { AssistantOrchestrator } from './orchestrator.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AssistantOrchestrator', () => {
  it('serializes requests within the same session', async () => {
    const orchestrator = new AssistantOrchestrator();
    const order: string[] = [];

    const p1 = orchestrator.dispatch(
      { agentId: 'default', userId: 'owner', channel: 'cli', content: 'first' },
      async () => {
        order.push('start-1');
        await sleep(25);
        order.push('end-1');
        return { content: 'done-1' };
      },
    );

    const p2 = orchestrator.dispatch(
      { agentId: 'default', userId: 'owner', channel: 'cli', content: 'second' },
      async () => {
        order.push('start-2');
        await sleep(10);
        order.push('end-2');
        return { content: 'done-2' };
      },
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.content).toBe('done-1');
    expect(r2.content).toBe('done-2');
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);

    const state = orchestrator.getState();
    expect(state.summary.totalRequests).toBe(2);
    expect(state.summary.completedRequests).toBe(2);
    expect(state.summary.failedRequests).toBe(0);
    expect(state.summary.sessionCount).toBe(1);
    expect(state.sessions[0].totalRequests).toBe(2);
    expect(state.sessions[0].queueDepth).toBe(0);
    expect(state.sessions[0].status).toBe('idle');
    expect(state.sessions[0].lastQueueWaitMs).toBeGreaterThanOrEqual(0);
    expect(state.sessions[0].lastExecutionMs).toBeGreaterThanOrEqual(0);
    expect(state.sessions[0].lastResponsePreview).toContain('done-2');
  });

  it('allows different sessions to run in parallel', async () => {
    const orchestrator = new AssistantOrchestrator();
    const started: string[] = [];

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sessionA = orchestrator.dispatch(
      { agentId: 'default', userId: 'owner-a', channel: 'cli', content: 'a' },
      async () => {
        started.push('a');
        await gate;
        return { content: 'a-ok' };
      },
    );

    const sessionB = orchestrator.dispatch(
      { agentId: 'default', userId: 'owner-b', channel: 'cli', content: 'b' },
      async () => {
        started.push('b');
        await gate;
        return { content: 'b-ok' };
      },
    );

    await sleep(20);
    expect(started).toContain('a');
    expect(started).toContain('b');

    release?.();
    const [a, b] = await Promise.all([sessionA, sessionB]);
    expect(a.content).toBe('a-ok');
    expect(b.content).toBe('b-ok');
  });

  it('tracks failures in state summary and session records', async () => {
    const orchestrator = new AssistantOrchestrator();

    await expect(
      orchestrator.dispatch(
        { agentId: 'default', userId: 'owner', channel: 'web', content: 'explode please' },
        async () => {
          await sleep(5);
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    const state = orchestrator.getState();
    expect(state.summary.totalRequests).toBe(1);
    expect(state.summary.completedRequests).toBe(0);
    expect(state.summary.failedRequests).toBe(1);
    expect(state.sessions[0].errorCount).toBe(1);
    expect(state.sessions[0].lastError).toBe('boom');
    expect(state.sessions[0].status).toBe('idle');
  });

  it('prioritizes high-priority requests ahead of lower-priority queued work in the same session', async () => {
    const orchestrator = new AssistantOrchestrator();
    const order: string[] = [];

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = orchestrator.dispatch(
      {
        agentId: 'default',
        userId: 'owner',
        channel: 'web',
        content: 'first',
        priority: 'normal',
        requestType: 'chat',
      },
      async () => {
        order.push('start-first');
        await firstGate;
        order.push('end-first');
        return { content: 'first-ok' };
      },
    );

    await sleep(10);

    const pLow = orchestrator.dispatch(
      {
        agentId: 'default',
        userId: 'owner',
        channel: 'web',
        content: 'low',
        priority: 'low',
        requestType: 'chat',
      },
      async () => {
        order.push('start-low');
        await sleep(5);
        order.push('end-low');
        return { content: 'low-ok' };
      },
    );

    const pHigh = orchestrator.dispatch(
      {
        agentId: 'default',
        userId: 'owner',
        channel: 'web',
        content: 'high',
        priority: 'high',
        requestType: 'chat',
      },
      async () => {
        order.push('start-high');
        await sleep(5);
        order.push('end-high');
        return { content: 'high-ok' };
      },
    );

    releaseFirst?.();
    const [, high, low] = await Promise.all([p1, pHigh, pLow]);
    expect(high.content).toBe('high-ok');
    expect(low.content).toBe('low-ok');
    expect(order).toEqual([
      'start-first',
      'end-first',
      'start-high',
      'end-high',
      'start-low',
      'end-low',
    ]);
  });

  it('marks queued request cancellation distinctly from failures', async () => {
    const orchestrator = new AssistantOrchestrator();
    const traces: string[] = [];
    orchestrator.subscribe((trace) => {
      if (trace.requestId === 'queued-cancel') {
        traces.push(trace.status);
      }
    });

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = orchestrator.dispatch(
      { agentId: 'default', userId: 'owner', channel: 'web', content: 'first' },
      async () => {
        await firstGate;
        return { content: 'done' };
      },
    );

    await sleep(10);

    const p2 = orchestrator.dispatch(
      {
        requestId: 'queued-cancel',
        agentId: 'default',
        userId: 'owner',
        channel: 'web',
        content: 'second',
      },
      async () => ({ content: 'should-not-run' }),
    );
    const cancelled = p2.catch((err) => err);

    orchestrator.cancelSession(
      { agentId: 'default', userId: 'owner', channel: 'web' },
      'Canceled from the web UI.',
    );

    const err = await cancelled;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Canceled from the web UI.');
    expect(traces).toContain('cancelled');

    releaseFirst?.();
    await p1;

    const state = orchestrator.getState();
    const trace = state.traces.find((entry) => entry.requestId === 'queued-cancel');
    expect(trace?.status).toBe('cancelled');
    expect(trace?.completedAt).toBeTypeOf('number');
    expect(trace?.endToEndMs).toBeGreaterThanOrEqual(0);
    expect(state.summary.failedRequests).toBe(0);
  });

  it('captures step-level traces from dispatch context', async () => {
    const orchestrator = new AssistantOrchestrator();

    const result = await orchestrator.dispatch(
      {
        agentId: 'default',
        userId: 'owner',
        channel: 'cli',
        content: 'trace please',
        requestType: 'chat',
      },
      async (ctx) => {
        ctx.markStep('input_validated', 'input accepted');
        return ctx.runStep(
          'provider_chat',
          async () => {
            await sleep(5);
            return { content: 'trace-ok' };
          },
          'simulated provider call',
        );
      },
    );

    expect(result.content).toBe('trace-ok');
    const state = orchestrator.getState();
    expect(state.traces.length).toBeGreaterThan(0);

    const trace = state.traces[0];
    expect(trace.status).toBe('succeeded');
    expect(trace.requestType).toBe('chat');
    expect(trace.steps.some((step) => step.name === 'input_validated' && step.status === 'succeeded')).toBe(true);
    expect(trace.steps.some((step) => step.name === 'provider_chat' && step.status === 'succeeded')).toBe(true);
  });

  it('tracks the active response source on the session snapshot', async () => {
    const orchestrator = new AssistantOrchestrator();

    await orchestrator.dispatch(
      {
        agentId: 'default',
        userId: 'owner',
        channel: 'web',
        content: 'trace source',
        requestType: 'chat',
        selectedResponseSource: {
          locality: 'external',
          providerName: 'ollama_cloud',
          providerProfileName: 'ollama-cloud-coding',
          providerTier: 'managed_cloud',
          model: 'qwen3-coder-next',
          usedFallback: false,
        },
      },
      async (ctx) => {
        ctx.addNode({
          kind: 'provider_call',
          name: 'Model response: anthropic • claude-opus-4.6',
          startedAt: 100,
          completedAt: 120,
          status: 'succeeded',
          metadata: {
            responseSource: {
              locality: 'external',
              providerName: 'anthropic',
              providerTier: 'frontier',
              model: 'claude-opus-4.6',
              usedFallback: false,
            },
          },
        });
        return { content: 'done' };
      },
    );

    const state = orchestrator.getState();
    expect(state.sessions[0].responseSource).toMatchObject({
      locality: 'external',
      providerName: 'anthropic',
      providerTier: 'frontier',
      model: 'claude-opus-4.6',
    });
  });
});
