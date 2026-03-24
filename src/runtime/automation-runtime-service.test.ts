import { describe, expect, it, vi } from 'vitest';
import { createAutomationRuntimeService } from './automation-runtime-service.js';

function makeService() {
  const workflows = [
    {
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      enabled: true,
      mode: 'sequential' as const,
      description: 'Reads example.com.',
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
    installPreset: vi.fn(() => ({ success: true, message: 'Installed preset.' })),
    history: vi.fn(() => []),
  };
  const onWorkflowSaved = vi.fn();
  const onWorkflowRunResult = vi.fn();
  const templateControl = {
    list: vi.fn(() => [
      {
        id: 'builtin-browser',
        category: 'system' as const,
        installed: false,
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
  };

  const service = createAutomationRuntimeService({
    workflows: workflowControl,
    tasks: taskControl,
    templates: templateControl,
    onWorkflowSaved,
    onWorkflowRunResult,
  });

  return { service, workflowControl, taskControl, templateControl, onWorkflowSaved, onWorkflowRunResult };
}

describe('automation-runtime-service', () => {
  it('wraps workflow callbacks with saved-automation side effects', async () => {
    const { service, workflowControl, taskControl, onWorkflowSaved, onWorkflowRunResult } = makeService();

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
    expect(onWorkflowRunResult).toHaveBeenCalledWith(expect.objectContaining({ success: true }), expect.objectContaining({
      playbookId: 'browser-read-smoke',
      origin: 'web',
    }));
  });

  it('exposes unified saved-automation catalog, mutations, and executor control plane', async () => {
    const { service, workflowControl, taskControl, templateControl } = makeService();

    expect(service.listSavedAutomations()).toHaveLength(2);
    expect(service.listAutomationCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser-read-smoke', source: 'saved_workflow' }),
      expect.objectContaining({ id: 'builtin-browser-read', source: 'builtin_template', builtin: true }),
    ]));
    expect(templateControl.list).toHaveBeenCalled();

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
    expect(executorControlPlane.listWorkflows()).toHaveLength(1);
    await executorControlPlane.runTask('task-agent-1');
    expect(taskControl.runNow).toHaveBeenCalledWith('task-agent-1');
  });
});
