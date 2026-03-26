import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationOutputStore } from './automation-output-store.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardianagent-automation-output-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AutomationOutputStore', () => {
  it('persists run manifests and supports search plus chunked reads', () => {
    const store = new AutomationOutputStore({ basePath: createTempDir(), now: () => 1_700_000_000_000 });

    const saved = store.saveRun({
      automationId: 'browser-read-smoke',
      automationName: 'Browser Read Smoke',
      runId: 'run-1',
      status: 'succeeded',
      message: 'Completed successfully.',
      runLink: '#/automations?runId=run-1',
      steps: [
        {
          stepId: 'read_page',
          toolName: 'browser_read',
          status: 'succeeded',
          message: 'Read page.',
          output: {
            url: 'https://example.com',
            content: 'Example Domain page snapshot',
          },
        },
        {
          stepId: 'list_links',
          toolName: 'browser_links',
          status: 'succeeded',
          message: 'Extracted links.',
          output: {
            links: [{ text: 'Learn more', href: 'https://iana.org/domains/example' }],
          },
        },
      ],
    });

    expect(saved).toMatchObject({
      runId: 'run-1',
      automationId: 'browser-read-smoke',
      status: 'succeeded',
      stepCount: 2,
    });

    expect(store.getManifest('run-1')).toMatchObject({
      automationName: 'Browser Read Smoke',
      steps: [
        expect.objectContaining({ stepId: 'read_page', toolName: 'browser_read' }),
        expect.objectContaining({ stepId: 'list_links', toolName: 'browser_links' }),
      ],
    });

    expect(store.search({ query: 'Learn more', limit: 5 })).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        stepId: 'list_links',
        toolName: 'browser_links',
      }),
    ]);

    expect(store.read({ runId: 'run-1', stepId: 'read_page' })).toMatchObject({
      runId: 'run-1',
      scope: 'step',
      stepId: 'read_page',
      toolName: 'browser_read',
    });
    expect(store.read({ runId: 'run-1', stepId: 'read_page' })?.text).toContain('Example Domain page snapshot');

    const chunked = store.read({ runId: 'run-1', offset: 0, maxChars: 40 });
    expect(chunked).toMatchObject({
      runId: 'run-1',
      scope: 'run',
      truncated: true,
    });
    expect(chunked?.nextOffset).toBeGreaterThan(0);
    expect(chunked?.text.length).toBeLessThanOrEqual(500);
  });
});
