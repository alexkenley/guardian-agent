/**
 * Tests for orchestration agents: Sequential, Parallel, Loop.
 */

import { describe, it, expect, vi } from 'vitest';
import { SequentialAgent, ParallelAgent, LoopAgent } from './orchestration.js';
import type { AgentContext, AgentResponse, UserMessage } from './types.js';

// ─── Test Helpers ─────────────────────────────────────────────

function makeMessage(content: string): UserMessage {
  return {
    id: 'msg-1',
    userId: 'user-1',
    channel: 'test',
    content,
    timestamp: Date.now(),
  };
}

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    agentId: 'orchestrator',
    capabilities: Object.freeze([]),
    emit: vi.fn().mockResolvedValue(undefined),
    checkAction: vi.fn(),
    ...overrides,
  };
}

// ─── SequentialAgent ──────────────────────────────────────────

describe('SequentialAgent', () => {
  it('runs steps in order and returns last result', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockResolvedValueOnce({ content: 'step-1-result' })
      .mockResolvedValueOnce({ content: 'step-2-result' });

    const agent = new SequentialAgent('seq-1', 'Sequential', {
      steps: [
        { agentId: 'agent-a', outputKey: 'a_output' },
        { agentId: 'agent-b', inputKey: 'a_output', outputKey: 'b_output' },
      ],
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toBe('agent-a');
    expect(dispatch.mock.calls[1][0]).toBe('agent-b');
    // Second step should receive first step's output as input
    expect(dispatch.mock.calls[1][1].content).toBe('step-1-result');
    expect(result.content).toBe('step-2-result');
    expect(result.metadata?.orchestration).toBe('sequential');
    expect(result.metadata?.completedSteps).toBe(2);
  });

  it('stops on error when stopOnError is true', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockResolvedValueOnce({ content: 'ok' })
      .mockRejectedValueOnce(new Error('agent-b failed'))
      .mockResolvedValueOnce({ content: 'should not run' });

    const agent = new SequentialAgent('seq-2', 'Sequential', {
      steps: [
        { agentId: 'agent-a' },
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
      ],
      stopOnError: true,
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Pipeline stopped');
    expect(result.content).toContain('agent-b');
    expect(result.metadata?.completedSteps).toBe(1);
  });

  it('continues on error when stopOnError is false', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockRejectedValueOnce(new Error('agent-a failed'))
      .mockResolvedValueOnce({ content: 'agent-b ok' });

    const agent = new SequentialAgent('seq-3', 'Sequential', {
      steps: [
        { agentId: 'agent-a' },
        { agentId: 'agent-b' },
      ],
      stopOnError: false,
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('agent-b ok');
    expect(result.metadata?.completedSteps).toBe(1);
  });

  it('returns error when dispatch is not available', async () => {
    const agent = new SequentialAgent('seq-4', 'Sequential', {
      steps: [{ agentId: 'agent-a' }],
    });

    const ctx = makeContext({ dispatch: undefined });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(result.content).toContain('requires dispatch capability');
  });
});

// ─── ParallelAgent ────────────────────────────────────────────

describe('ParallelAgent', () => {
  it('runs all steps concurrently and combines results', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockImplementation(async (agentId) => {
        return { content: `${agentId}-result` };
      });

    const agent = new ParallelAgent('par-1', 'Parallel', {
      steps: [
        { agentId: 'agent-a' },
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
      ],
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.content).toContain('agent-a-result');
    expect(result.content).toContain('agent-b-result');
    expect(result.content).toContain('agent-c-result');
    expect(result.metadata?.orchestration).toBe('parallel');
    expect(result.metadata?.succeeded).toBe(3);
    expect(result.metadata?.failed).toBe(0);
  });

  it('handles mixed success and failure', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockImplementation(async (agentId) => {
        if (agentId === 'agent-b') throw new Error('agent-b exploded');
        return { content: `${agentId}-ok` };
      });

    const agent = new ParallelAgent('par-2', 'Parallel', {
      steps: [
        { agentId: 'agent-a' },
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
      ],
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.content).toContain('agent-a-ok');
    expect(result.content).toContain('Error');
    expect(result.content).toContain('agent-c-ok');
    expect(result.metadata?.succeeded).toBe(2);
    expect(result.metadata?.failed).toBe(1);
  });

  it('respects maxConcurrency limit', async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;

    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockImplementation(async (agentId) => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await new Promise(r => setTimeout(r, 10));
        concurrentCalls--;
        return { content: `${agentId}-done` };
      });

    const agent = new ParallelAgent('par-3', 'Parallel', {
      steps: [
        { agentId: 'a1' },
        { agentId: 'a2' },
        { agentId: 'a3' },
        { agentId: 'a4' },
      ],
      maxConcurrency: 2,
    });

    const ctx = makeContext({ dispatch });
    await agent.onMessage(makeMessage('hello'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('returns error when dispatch is not available', async () => {
    const agent = new ParallelAgent('par-4', 'Parallel', {
      steps: [{ agentId: 'agent-a' }],
    });

    const ctx = makeContext({ dispatch: undefined });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(result.content).toContain('requires dispatch capability');
  });
});

// ─── LoopAgent ────────────────────────────────────────────────

describe('LoopAgent', () => {
  it('loops until condition returns false', async () => {
    let callCount = 0;
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockImplementation(async () => {
        callCount++;
        return { content: callCount < 3 ? 'continue' : 'done' };
      });

    const agent = new LoopAgent('loop-1', 'Loop', {
      agentId: 'worker',
      maxIterations: 10,
      condition: (iteration, lastResponse) => {
        if (!lastResponse) return true;
        return lastResponse.content !== 'done';
      },
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('start'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.content).toBe('done');
    expect(result.metadata?.orchestration).toBe('loop');
    expect(result.metadata?.iterations).toBe(3);
  });

  it('respects maxIterations cap', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockResolvedValue({ content: 'keep going' });

    const agent = new LoopAgent('loop-2', 'Loop', {
      agentId: 'worker',
      maxIterations: 3,
      condition: () => true, // always continue
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('start'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.metadata?.iterations).toBe(3);
    expect(result.metadata?.maxIterations).toBe(3);
  });

  it('stops on error and reports it', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockResolvedValueOnce({ content: 'ok' })
      .mockRejectedValueOnce(new Error('loop failure'));

    const agent = new LoopAgent('loop-3', 'Loop', {
      agentId: 'worker',
      maxIterations: 5,
    });

    const ctx = makeContext({ dispatch });
    const result = await agent.onMessage(makeMessage('start'), ctx);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Loop stopped');
    expect(result.content).toContain('loop failure');
    expect(result.metadata?.stoppedByError).toBe(true);
  });

  it('feeds previous output as input by default', async () => {
    const dispatch = vi.fn<[string, UserMessage], Promise<AgentResponse>>()
      .mockResolvedValueOnce({ content: 'first output' })
      .mockResolvedValueOnce({ content: 'second output' })
      .mockResolvedValueOnce({ content: '' }); // empty = stop

    const agent = new LoopAgent('loop-4', 'Loop', {
      agentId: 'worker',
      maxIterations: 5,
    });

    const ctx = makeContext({ dispatch });
    await agent.onMessage(makeMessage('initial'), ctx);

    // First call gets original message
    expect(dispatch.mock.calls[0][1].content).toBe('initial');
    // Second call gets first output
    expect(dispatch.mock.calls[1][1].content).toBe('first output');
    // Third call gets second output
    expect(dispatch.mock.calls[2][1].content).toBe('second output');
  });

  it('returns error when dispatch is not available', async () => {
    const agent = new LoopAgent('loop-5', 'Loop', {
      agentId: 'worker',
    });

    const ctx = makeContext({ dispatch: undefined });
    const result = await agent.onMessage(makeMessage('hello'), ctx);

    expect(result.content).toContain('requires dispatch capability');
  });
});
