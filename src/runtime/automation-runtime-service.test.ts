import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationRuntimeService } from './automation-runtime-service.js';
import { AutomationOutputStore } from './automation-output-store.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardianagent-automation-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeService() {
  const workflows = [
    {
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      enabled: true,
      mode: 'sequential' as const,
      description: 'Reads example.com.',
      signature: 'sig-existing',
      steps: [
        { id: 'step-1', type: 'tool' as const, packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
      ],
    },
  ];
  const tasks = [
    {
      id: 'task-linked-1',
      name: 'Browser Read Smoke',
      type: 'playbook' as const,
      target: 'browser-read-smoke',
      cron: '0 8 * * 1',
      enabled: true,
      createdAt: 1,
      scopeHash: 'scope-a',
      maxRunsPerWindow: 1,
      dailySpendCap: 0,
      providerSpendCap: 0,
      consecutiveFailureCount: 0,
      consecutiveDeniedCount: 0,
      runCount: 0,
    },
    {
      id: 'task-agent-1',
      name: 'Inbox Triage',
      type: 'agent' as const,
      target: 'default',
      eventTrigger: { eventType: 'automation:manual:inbox-triage' },
      enabled: true,
      createdAt: 1,
      scopeHash: 'scope-b',
      maxRunsPerWindow: 1,
      dailySpendCap: 0,
      providerSpendCap: 0,
      consecutiveFailureCount: 0,
      consecutiveDeniedCount: 0,
      runCount: 0,
    },
  ];

  const workflowControl = {
    list: vi.fn(() => workflows),
    history: vi.fn(() => [
      {
        id: 'run-1',
        runId: 'run-1',
        graphId: 'graph-1',
        playbookId: 'browser-read-smoke',
        playbookName: 'Browser Read Smoke',
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        dryRun: false,
        status: 'succeeded' as const,
        message: 'Ran workflow.',
        steps: [],
        origin: 'web' as const,
        events: [],
      },
    ]),
    upsert: vi.fn(() => ({ success: true, message: 'Updated workflow.' })),
    delete: vi.fn(() => ({ success: true, message: 'Deleted workflow.' })),
    run: vi.fn(async () => ({
      success: true,
      status: 'succeeded' as const,
      message: 'Ran workflow.',
      run: {
        id: 'run-1',
        runId: 'run-1',
        graphId: 'graph-1',
        playbookId: 'browser-read-smoke',
        playbookName: 'Browser Read Smoke',
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        dryRun: false,
        status: 'succeeded' as const,
        message: 'Ran workflow.',
        steps: [],
        origin: 'web' as const,
        events: [],
      },
    })),
  };
  const taskControl = {
    list: vi.fn(() => tasks),
    get: vi.fn((id: string) => tasks.find((task) => task.id === id) ?? null),
    create: vi.fn(() => ({ success: true, message: 'Created task.', task: tasks[0] })),
    update: vi.fn(() => ({ success: true, message: 'Updated task.' })),
    delete: vi.fn(() => ({ success: true, message: 'Deleted task.' })),
    runNow: vi.fn(async () => ({ success: true, message: 'Task run started.' })),
    presets: vi.fn(() => []),
    createFromPresetExample: vi.fn(() => ({ success: true, message: 'Created starter example.' })),
    history: vi.fn(() => []),
  };
  const onWorkflowSaved = vi.fn();
  const outputStore = new AutomationOutputStore({ basePath: join(createTempDir(), 'automation-output') });
  const templateControl = {
    list: vi.fn(() => [
      {
        id: 'builtin-browser',
        category: 'system' as const,
        materialized: false,
        playbooks: [
          {
            id: 'builtin-browser-read',
            name: 'Builtin Browser Read',
            enabled: true,
            mode: 'sequential' as const,
            description: 'Starter browser workflow.',
            steps: [
              { id: 'step-1', type: 'tool' as const, packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
            ],
          },
        ],
      },
    ]),
    createFromExample: vi.fn(() => ({ success: true, message: 'Created starter example.' })),
  };

  const service = createAutomationRuntimeService({
    workflows: workflowControl,
    tasks: taskControl,
    templates: templateControl,
    outputStore,
    toolMetadata: [
      {
        name: 'browser_navigate',
        category: 'browser',
        description: 'Open a page.',
        shortDescription: 'Open page',
      },
    ],
    onWorkflowSaved,
  });

  return { service, workflowControl, taskControl, templateControl, onWorkflowSaved, outputStore };
}

describe('automation-runtime-service', () => {
  it('wraps workflow callbacks with saved-automation side effects', async () => {
    const { service, workflowControl, taskControl, onWorkflowSaved } = makeService();

    const upsertResult = service.upsertWorkflow({
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      enabled: false,
      mode: 'sequential',
      description: 'Reads example.com.',
      steps: [{ id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } }],
    });
    expect(upsertResult.success).toBe(true);
    expect(onWorkflowSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'browser-read-smoke', enabled: false }));

    const deleteResult = service.deleteWorkflow('browser-read-smoke');
    expect(deleteResult.success).toBe(true);
    expect(workflowControl.delete).toHaveBeenCalledWith('browser-read-smoke');
    expect(taskControl.delete).toHaveBeenCalledWith('task-linked-1');

    const runResult = await service.runWorkflow({
      playbookId: 'browser-read-smoke',
      origin: 'web',
      channel: 'web',
      userId: 'web-user',
    });
    expect(runResult.success).toBe(true);
    expect(workflowControl.run).toHaveBeenCalledWith(expect.objectContaining({
      playbookId: 'browser-read-smoke',
      origin: 'web',
    }));
  });

  it('exposes unified saved-automation catalog, mutations, and executor control plane', async () => {
    const { service, workflowControl, taskControl, templateControl } = makeService();

    expect(service.listSavedAutomations()).toHaveLength(2);
    expect(service.listAutomationCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser-read-smoke', source: 'saved_workflow' }),
      expect.objectContaining({ id: 'builtin-browser-read', source: 'builtin_example', builtin: true }),
    ]));
    expect(service.listAutomationCatalogView()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser-read-smoke', category: 'browser', sourceKind: 'workflow' }),
      expect.objectContaining({ id: 'task-agent-1', kind: 'assistant', sourceKind: 'task' }),
      expect.objectContaining({ id: 'builtin-browser-read', builtin: true, sourceKind: 'example' }),
    ]));
    expect(service.listAutomationRunHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'run-1', source: 'automation' }),
    ]));
    expect(templateControl.list).toHaveBeenCalled();

    expect(service.createAutomationFromCatalog('builtin-browser-read')).toMatchObject({
      success: true,
      action: 'created',
      automationId: 'builtin-browser-read',
    });
    expect(templateControl.createFromExample).toHaveBeenCalledWith('builtin-browser');

    expect(service.saveAutomation({
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      enabled: true,
      kind: 'workflow',
      mode: 'sequential',
      steps: [
        { id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
      ],
      existingTaskId: 'task-linked-1',
      schedule: { enabled: true, cron: '0 8 * * 1' },
    })).toMatchObject({
      success: true,
      automationId: 'browser-read-smoke',
      taskId: 'task-linked-1',
    });
    expect(workflowControl.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'browser-read-smoke',
      signature: 'sig-existing',
    }));
    expect(taskControl.update).toHaveBeenCalledWith('task-linked-1', expect.objectContaining({
      name: 'Browser Read Smoke',
      type: 'playbook',
      target: 'browser-read-smoke',
      cron: '0 8 * * 1',
    }));

    expect(service.setSavedAutomationEnabled('task-agent-1', false).success).toBe(true);
    expect(taskControl.update).toHaveBeenCalledWith('task-agent-1', { enabled: false });

    const runResult = await service.runSavedAutomation({
      automationId: 'browser-read-smoke',
      origin: 'web',
      channel: 'web',
      userId: 'web-user',
    });
    expect(runResult.success).toBe(true);
    expect(workflowControl.run).toHaveBeenCalledWith(expect.objectContaining({
      playbookId: 'browser-read-smoke',
      origin: 'web',
    }));

    const executorControlPlane = service.createExecutorControlPlane();
    expect(executorControlPlane.listAutomations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser-read-smoke', source: 'saved_workflow' }),
      expect.objectContaining({ id: 'builtin-browser-read', source: 'builtin_example', builtin: true }),
    ]));
    expect(executorControlPlane.listWorkflows()).toHaveLength(1);
    expect(executorControlPlane.setAutomationEnabled('task-agent-1', false).success).toBe(true);
    expect(executorControlPlane.deleteAutomation('task-agent-1').success).toBe(true);
    await executorControlPlane.runAutomation({ automationId: 'browser-read-smoke', origin: 'web' });
    await executorControlPlane.runTask('task-agent-1');
    expect(workflowControl.run).toHaveBeenCalledWith(expect.objectContaining({ playbookId: 'browser-read-smoke' }));
    expect(taskControl.runNow).toHaveBeenCalledWith('task-agent-1');
  });

  it('includes persisted stored runs in automation history after live ledgers are empty', () => {
    const { service, workflowControl, taskControl, outputStore } = makeService();
    workflowControl.history.mockReturnValue([]);
    taskControl.history.mockReturnValue([]);
    outputStore.saveRun({
      automationId: 'hn-snapshot-smoke',
      automationName: 'HN Snapshot Smoke',
      runId: 'run-persisted-1',
      status: 'succeeded',
      message: 'Persisted run.',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      steps: [
        {
          stepId: 'list_links',
          toolName: 'browser_links',
          status: 'succeeded',
          output: {
            links: [{ text: 'Hacker News', href: 'https://news.ycombinator.com/news' }],
          },
        },
      ],
    });
    outputStore.setMemoryPromotion('run-persisted-1', {
      status: 'saved',
      agentId: 'default',
      entryId: 'entry-persisted-1',
    });

    expect(service.listAutomationRunHistory()).toEqual([
      expect.objectContaining({
        id: 'run-persisted-1',
        name: 'HN Snapshot Smoke',
        storedOutput: expect.objectContaining({ status: 'saved' }),
        memoryPromotion: expect.objectContaining({ status: 'saved', entryId: 'entry-persisted-1' }),
      }),
    ]);
  });

  it('saves raw workflow definitions through the automation runtime contract', () => {
    const { service, workflowControl, taskControl } = makeService();

    const result = service.saveAutomationDefinition('browser-read-smoke', {
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke v2',
      enabled: false,
      mode: 'parallel',
      description: 'Updated browser smoke.',
      steps: [
        { id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
        { id: 'step-2', type: 'tool', packId: '', toolName: 'browser_snapshot', args: {} },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      automationId: 'browser-read-smoke',
      taskId: 'task-linked-1',
    });
    expect(workflowControl.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke v2',
      enabled: false,
      mode: 'parallel',
      description: 'Updated browser smoke.',
    }));
    expect(taskControl.update).toHaveBeenCalledWith('task-linked-1', {
      name: 'Browser Read Smoke v2',
      outputHandling: undefined,
    });

    expect(service.saveAutomationDefinition('builtin-browser-read', {
      id: 'builtin-browser-read',
      name: 'Builtin Browser Read',
      enabled: true,
      mode: 'sequential',
      steps: [
        { id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
      ],
    })).toMatchObject({
      success: false,
      message: expect.stringContaining('Create a copy'),
    });

    expect(service.saveAutomationDefinition('task-agent-1', {
      id: 'task-agent-1',
      name: 'Inbox Triage',
      enabled: true,
      mode: 'sequential',
      steps: [
        { id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
      ],
    })).toMatchObject({
      success: false,
      message: expect.stringContaining('Only step-based automations'),
    });
  });
});
