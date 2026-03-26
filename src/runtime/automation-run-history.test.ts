import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAutomationRunHistoryEntries,
  buildPersistedAutomationRunHistoryEntries,
} from './automation-run-history.js';
import { AutomationOutputStore } from './automation-output-store.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardianagent-automation-run-history-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
          storedOutput: { status: 'saved', runId: 'run-1', storeId: 'store-1', stepCount: 1, trustLevel: 'trusted', taintReasons: [] },
          memoryPromotion: { status: 'saved', agentId: 'default', entryId: 'entry-1' },
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
        storedOutput: expect.objectContaining({ status: 'saved', storeId: 'store-1' }),
        memoryPromotion: expect.objectContaining({ status: 'saved', agentId: 'default' }),
      }),
    ]);
  });

  it('rebuilds persisted run history entries from the automation output store', () => {
    const store = new AutomationOutputStore({ basePath: join(createTempDir(), 'automation-output'), now: () => 1_700_000_000_000 });
    store.saveRun({
      automationId: 'hn-snapshot-smoke',
      automationName: 'HN Snapshot Smoke',
      runId: 'run-10',
      status: 'succeeded',
      message: 'Automation completed successfully.',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_200,
      steps: [
        {
          stepId: 'read_page',
          toolName: 'browser_read',
          status: 'succeeded',
          message: 'Read Hacker News.',
          output: {
            url: 'https://news.ycombinator.com',
            contentType: 'snapshot',
            content: '### Page\n- Page Title: Hacker News',
          },
        },
      ],
    });
    store.setMemoryPromotion('run-10', {
      status: 'saved',
      agentId: 'default',
      entryId: 'entry-10',
    });

    const entries = buildPersistedAutomationRunHistoryEntries(store.listRecentRuns(10), store);
    expect(entries).toEqual([
      expect.objectContaining({
        id: 'run-10',
        name: 'HN Snapshot Smoke',
        source: 'automation',
        status: 'succeeded',
        duration: 1200,
        storedOutput: expect.objectContaining({ status: 'saved', storeId: expect.any(String) }),
        memoryPromotion: expect.objectContaining({ status: 'saved', entryId: 'entry-10' }),
        steps: [
          expect.objectContaining({
            stepId: 'read_page',
            toolName: 'browser_read',
            output: expect.objectContaining({ content: '### Page\n- Page Title: Hacker News' }),
          }),
        ],
      }),
    ]);
  });
});
