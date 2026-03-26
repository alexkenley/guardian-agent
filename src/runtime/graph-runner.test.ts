import { describe, expect, it } from 'vitest';
import { GraphRunner } from './graph-runner.js';
import type { PlaybookGraphDefinition } from './graph-types.js';

describe('GraphRunner', () => {
  it('executes sequential graph nodes and checkpoints results', async () => {
    const runner = new GraphRunner<{ stepId: string; status: string; message: string }>({
      now: (() => {
        let now = 1_000;
        return () => ++now;
      })(),
      runIdFactory: () => 'run-1',
    });

    const graph: PlaybookGraphDefinition = {
      id: 'wf:v1',
      name: 'Workflow',
      playbookId: 'wf',
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', next: 'step-1' },
        { id: 'step-1', type: 'step', step: { id: 'step-1', packId: '', toolName: 'fs_read', args: { path: './a.txt' } }, next: 'end' },
        { id: 'end', type: 'end' },
      ],
    };

    const result = await runner.run(graph, {
      executeStep: async (node) => ({
        status: 'succeeded',
        results: [{ stepId: node.step.id, status: 'succeeded', message: 'ok' }],
        message: 'ok',
      }),
      executeParallel: async () => ({ status: 'succeeded', results: [], message: 'ok' }),
    });

    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(1);
    expect(result.message).toBe(`Automation 'Workflow' completed successfully.`);
    expect(result.events.some((event) => event.type === 'run_created')).toBe(true);
    expect(result.events.some((event) => event.type === 'run_completed')).toBe(true);
    expect(runner.getStore().get('run-1')?.completedNodeIds).toContain('step-1');
  });

  it('surfaces approval interrupts as run events', async () => {
    const runner = new GraphRunner<{ stepId: string; status: string; message: string; approvalId?: string }>({
      runIdFactory: () => 'run-approval',
    });

    const graph: PlaybookGraphDefinition = {
      id: 'wf:v1',
      name: 'Workflow',
      playbookId: 'wf',
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', next: 'step-1' },
        { id: 'step-1', type: 'step', step: { id: 'step-1', packId: '', toolName: 'gmail_draft', args: {} }, next: 'end' },
        { id: 'end', type: 'end' },
      ],
    };

    const result = await runner.run(graph, {
      executeStep: async (node) => ({
        status: 'pending_approval',
        results: [{ stepId: node.step.id, status: 'pending_approval', message: 'Needs approval', approvalId: 'approval-1' }],
        message: 'Needs approval',
      }),
      executeParallel: async () => ({ status: 'succeeded', results: [], message: 'ok' }),
    });

    expect(result.status).toBe('awaiting_approval');
    expect(result.events.some((event) => event.type === 'approval_requested')).toBe(true);
    expect(result.events.some((event) => event.type === 'run_interrupted')).toBe(true);
  });

  it('resumes from the next node after a checkpoint is cleared for continuation', async () => {
    const runner = new GraphRunner<{ stepId: string; status: string; message: string; approvalId?: string }>({
      runIdFactory: () => 'run-resume',
    });

    const graph: PlaybookGraphDefinition = {
      id: 'wf:v1',
      name: 'Workflow',
      playbookId: 'wf',
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', next: 'step-1' },
        { id: 'step-1', type: 'step', step: { id: 'step-1', packId: '', toolName: 'gmail_draft', args: {} }, next: 'end' },
        { id: 'end', type: 'end' },
      ],
    };

    const interrupted = await runner.run(graph, {
      executeStep: async (node) => ({
        status: 'pending_approval',
        results: [{ stepId: node.step.id, status: 'pending_approval', message: 'Needs approval', approvalId: 'approval-1' }],
        message: 'Needs approval',
      }),
      executeParallel: async () => ({ status: 'succeeded', results: [], message: 'ok' }),
    });

    const checkpoint = runner.getStore().get(interrupted.runId)!;
    runner.getStore().save({
      ...checkpoint,
      status: 'running',
      pendingApprovalIds: [],
    });

    const resumed = await runner.resume(graph, interrupted.runId, {
      executeStep: async () => ({ status: 'succeeded', results: [], message: 'ok' }),
      executeParallel: async () => ({ status: 'succeeded', results: [], message: 'ok' }),
    });

    expect(resumed.status).toBe('succeeded');
    expect(resumed.events.some((event) => event.type === 'run_resumed')).toBe(true);
  });
});
