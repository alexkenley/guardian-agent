import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMemoryStore } from './agent-memory-store.js';
import { AutomationOutputPersistenceService } from './automation-output-persistence.js';
import { AutomationOutputStore } from './automation-output-store.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardianagent-automation-memory-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AutomationOutputPersistenceService', () => {
  it('stores full automation output and writes a searchable memory reference', () => {
    const basePath = createTempDir();
    const outputStore = new AutomationOutputStore({ basePath: join(basePath, 'automation-output') });
    const memoryStore = new AgentMemoryStore({
      enabled: true,
      basePath: join(basePath, 'memory'),
      readOnly: false,
    });
    const service = new AutomationOutputPersistenceService({
      outputStore,
      agentMemoryStore: memoryStore,
      defaultAgentId: 'default',
      now: () => 1_700_000_000_000,
    });

    const result = service.persistRun({
      automationId: 'browser-read-smoke',
      automationName: 'Browser Read Smoke',
      runId: 'run-1',
      status: 'succeeded',
      outputHandling: {
        notify: 'off',
        sendToSecurity: 'off',
        persistArtifacts: 'run_history_plus_memory',
      },
      steps: [
        {
          stepId: 'read_page',
          toolName: 'browser_read',
          status: 'succeeded',
          message: 'Read page.',
          output: {
            content: 'Example Domain page snapshot',
          },
        },
      ],
    });

    expect(result.storedOutput).toMatchObject({
      status: 'saved',
      runId: 'run-1',
      stepCount: 1,
    });
    expect(result.memoryPromotion).toMatchObject({
      status: 'saved',
      agentId: 'default',
    });

    const entries = memoryStore.getEntries('default');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      category: 'Automation Results',
      sourceType: 'system',
      trustLevel: 'trusted',
      status: 'active',
    });
    expect(entries[0].content).toContain('automation_output_search');
    expect(entries[0].content).not.toContain('Example Domain page snapshot');

    expect(outputStore.read({ runId: 'run-1' })?.text).toContain('Example Domain page snapshot');
    expect(outputStore.getManifest('run-1')?.memoryPromotion).toMatchObject({
      status: 'saved',
      agentId: 'default',
      entryId: expect.any(String),
    });
  });

  it('skips persistence when historical analysis is disabled', () => {
    const basePath = createTempDir();
    const outputStore = new AutomationOutputStore({ basePath: join(basePath, 'automation-output') });
    const memoryStore = new AgentMemoryStore({
      enabled: true,
      basePath: join(basePath, 'memory'),
      readOnly: false,
    });
    const service = new AutomationOutputPersistenceService({
      outputStore,
      agentMemoryStore: memoryStore,
      defaultAgentId: 'default',
    });

    const result = service.persistRun({
      automationId: 'browser-read-smoke',
      automationName: 'Browser Read Smoke',
      runId: 'run-2',
      status: 'succeeded',
      outputHandling: {
        notify: 'off',
        sendToSecurity: 'off',
        persistArtifacts: 'run_history_only',
      },
      steps: [],
    });

    expect(result.storedOutput.status).toBe('skipped');
    expect(result.memoryPromotion.status).toBe('skipped');
    expect(memoryStore.getEntries('default')).toHaveLength(0);
    expect(outputStore.getManifest('run-2')).toBeNull();
  });

  it('stores output even when memory is read-only, but marks promotion blocked', () => {
    const basePath = createTempDir();
    const outputStore = new AutomationOutputStore({ basePath: join(basePath, 'automation-output') });
    const memoryStore = new AgentMemoryStore({
      enabled: true,
      basePath: join(basePath, 'memory'),
      readOnly: true,
    });
    const service = new AutomationOutputPersistenceService({
      outputStore,
      agentMemoryStore: memoryStore,
      defaultAgentId: 'default',
    });

    const result = service.persistRun({
      automationId: 'browser-read-smoke',
      automationName: 'Browser Read Smoke',
      runId: 'run-3',
      status: 'succeeded',
      outputHandling: {
        notify: 'off',
        sendToSecurity: 'off',
        persistArtifacts: 'run_history_plus_memory',
      },
      steps: [],
    });

    expect(result.storedOutput.status).toBe('saved');
    expect(result.memoryPromotion).toMatchObject({
      status: 'blocked',
      reason: 'Agent memory is read-only.',
    });
    expect(outputStore.getManifest('run-3')?.memoryPromotion).toMatchObject({
      status: 'blocked',
      reason: 'Agent memory is read-only.',
    });
  });
});
