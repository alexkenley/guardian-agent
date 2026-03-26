import { describe, expect, it } from 'vitest';
import { buildAutomationRunHistoryEntries } from './automation-run-history.js';

describe('automation-run-history', () => {
  it('merges automation runs and scheduled task history into one operator-facing ledger', () => {
    const entries = buildAutomationRunHistoryEntries(
      [
        {
          id: 'run-1',
          runId: 'run-1',
          graphId: 'graph-1',
          playbookId: 'browser-read-smoke',
          playbookName: 'Browser Read Smoke',
          createdAt: 100,
          startedAt: 110,
          completedAt: 150,
          durationMs: 40,
          dryRun: false,
          status: 'succeeded',
          message: 'Workflow run finished.',
          steps: [
            { stepId: 'step-1', toolName: 'browser_navigate', packId: '', status: 'succeeded', message: 'Opened page.', durationMs: 10 },
          ],
          outputHandling: { notify: 'off', sendToSecurity: 'off', persistArtifacts: 'run_history_only' },
          promotedFindings: [],
          origin: 'web',
          events: [],
        },
      ],
      [
        {
          id: 'task-history-1',
          taskId: 'task-agent-1',
          taskName: 'Inbox Triage',
          taskType: 'agent',
          target: 'default',
          timestamp: 200,
          status: 'succeeded',
          durationMs: 30,
          message: 'Assistant task finished.',
          steps: [
            { toolName: 'email_search', status: 'succeeded', message: 'Checked inbox.', durationMs: 12 },
          ],
          promotedFindings: [],
        },
      ],
    );

    expect(entries).toEqual([
      expect.objectContaining({
        id: 'task-history-1',
        source: 'scheduled assistant',
        name: 'Inbox Triage',
        status: 'succeeded',
        duration: 30,
      }),
      expect.objectContaining({
        id: 'run-1',
        source: 'automation',
        name: 'Browser Read Smoke',
        status: 'succeeded',
        duration: 40,
        message: 'Workflow run finished.',
      }),
    ]);
  });
});
