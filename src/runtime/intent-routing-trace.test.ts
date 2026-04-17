import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntentRoutingTraceLog } from './intent-routing-trace.js';

describe('IntentRoutingTraceLog', () => {
  it('persists structured routing events and reads the tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-intent-trace-'));
    try {
      const trace = new IntentRoutingTraceLog({
        directory: dir,
        maxFileSizeBytes: 10_000,
      });
      await trace.init();
      trace.record({
        stage: 'gateway_classified',
        userId: 'user-1',
        channel: 'web',
        contentPreview: 'Use Codex to say hello.',
        details: {
          route: 'coding_task',
          codingBackend: 'codex',
        },
      });
      await trace.flush();

      const tail = await trace.readTail(10);
      expect(tail).toHaveLength(1);
      expect(tail[0]).toMatchObject({
        stage: 'gateway_classified',
        userId: 'user-1',
        channel: 'web',
        contentPreview: 'Use Codex to say hello.',
      });
      expect(tail[0]?.details).toMatchObject({
        route: 'coding_task',
        codingBackend: 'codex',
      });

      const status = trace.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.filePath).toContain(dir);
      await expect(stat(status.filePath)).resolves.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rotates files and still returns the newest tail entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-intent-trace-'));
    try {
      const trace = new IntentRoutingTraceLog({
        directory: dir,
        maxFileSizeBytes: 250,
        maxFiles: 3,
      });
      await trace.init();

      for (let index = 0; index < 6; index++) {
        trace.record({
          stage: 'tier_routing_decided',
          userId: 'user-1',
          channel: 'web',
          contentPreview: `message ${index}`,
          details: {
            selectedAgentId: index % 2 === 0 ? 'local' : 'external',
            tier: index % 2 === 0 ? 'local' : 'external',
          },
        });
      }
      await trace.flush();

      const tail = await trace.readTail(3);
      expect(tail).toHaveLength(3);
      expect(tail.map((entry) => entry.contentPreview)).toEqual([
        'message 3',
        'message 4',
        'message 5',
      ]);

      await expect(stat(`${trace.getStatus().filePath}.1`)).resolves.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists recent entries with continuity and execution-ref filters applied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-intent-trace-'));
    try {
      const trace = new IntentRoutingTraceLog({
        directory: dir,
        maxFileSizeBytes: 10_000,
      });
      await trace.init();
      trace.record({
        stage: 'gateway_classified',
        userId: 'user-1',
        channel: 'web',
        contentPreview: 'first',
        details: {
          continuityKey: 'continuity-1',
          activeExecutionRefs: ['code_session:Repo Fix'],
        },
      });
      trace.record({
        stage: 'dispatch_response',
        userId: 'user-1',
        channel: 'web',
        contentPreview: 'second',
        details: {
          continuityKey: 'continuity-2',
          activeExecutionRefs: ['pending_action:approval-2'],
        },
      });
      await trace.flush();

      const continuityFiltered = await trace.listRecent({ limit: 10, continuityKey: 'continuity-1' });
      expect(continuityFiltered).toHaveLength(1);
      expect(continuityFiltered[0]?.contentPreview).toBe('first');

      const execFiltered = await trace.listRecent({ limit: 10, activeExecutionRef: 'approval-2' });
      expect(execFiltered).toHaveLength(1);
      expect(execFiltered[0]?.contentPreview).toBe('second');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts delegated worker stages for filtered reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-intent-trace-'));
    try {
      const trace = new IntentRoutingTraceLog({
        directory: dir,
        maxFileSizeBytes: 10_000,
      });
      await trace.init();
      trace.record({
        stage: 'delegated_worker_started',
        requestId: 'req-delegated',
        userId: 'user-1',
        channel: 'web',
        agentId: 'agent-1',
        contentPreview: 'Do the repo fix.',
        details: {
          agentName: 'Workspace Implementer',
          lifecycle: 'running',
        },
      });
      trace.record({
        stage: 'delegated_worker_completed',
        requestId: 'req-delegated',
        userId: 'user-1',
        channel: 'web',
        agentId: 'agent-1',
        contentPreview: 'Do the repo fix.',
        details: {
          agentName: 'Workspace Implementer',
          lifecycle: 'completed',
        },
      });
      await trace.flush();

      const entries = await trace.listRecent({
        limit: 10,
        requestId: 'req-delegated',
        stage: 'delegated_worker_completed',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        stage: 'delegated_worker_completed',
        requestId: 'req-delegated',
        details: {
          agentName: 'Workspace Implementer',
          lifecycle: 'completed',
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
