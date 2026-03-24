import { describe, expect, it, vi } from 'vitest';
import {
  deleteSavedAutomation,
  getSavedAutomationById,
  listSavedAutomations,
  runSavedAutomation,
  setSavedAutomationEnabled,
  type AutomationManagerControlPlane,
} from './automation-manager.js';

function makeControlPlane(): AutomationManagerControlPlane {
  const workflows = [
    {
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      enabled: true,
      mode: 'sequential' as const,
      description: 'Reads a page.',
      steps: [
        { id: 'navigate', type: 'tool' as const, packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
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

  return {
    listWorkflows: () => workflows,
    listTasks: () => tasks,
    upsertWorkflow: vi.fn(() => ({ success: true, message: 'Updated workflow.' })),
    updateTask: vi.fn(() => ({ success: true, message: 'Updated task.' })),
    deleteWorkflow: vi.fn(() => ({ success: true, message: 'Deleted workflow.' })),
    deleteTask: vi.fn(() => ({ success: true, message: 'Deleted task.' })),
    runWorkflow: vi.fn(async () => ({ success: true, status: 'succeeded', run: { playbookId: 'browser-read-smoke' } })),
    runTask: vi.fn(async () => ({ success: true, message: 'Task run started.' })),
  };
}

describe('automation-manager', () => {
  it('lists and selects saved automations from the unified catalog', () => {
    const controlPlane = makeControlPlane();
    const catalog = listSavedAutomations(controlPlane);

    expect(catalog).toHaveLength(2);
    expect(getSavedAutomationById(controlPlane, 'browser-read-smoke')?.name).toBe('Browser Read Smoke');
    expect(getSavedAutomationById(controlPlane, 'task-agent-1')?.name).toBe('Inbox Triage');
  });

  it('toggles workflows and assistant tasks through the unified control plane', () => {
    const controlPlane = makeControlPlane();

    expect(setSavedAutomationEnabled(controlPlane, 'browser-read-smoke', false).success).toBe(true);
    expect(controlPlane.upsertWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'browser-read-smoke',
      enabled: false,
    }));

    expect(setSavedAutomationEnabled(controlPlane, 'task-agent-1', false).success).toBe(true);
    expect(controlPlane.updateTask).toHaveBeenCalledWith('task-agent-1', { enabled: false });
  });

  it('runs and deletes saved automations through the unified control plane', async () => {
    const controlPlane = makeControlPlane();

    const workflowRun = await runSavedAutomation(controlPlane, 'browser-read-smoke', { origin: 'web', channel: 'web', userId: 'web-user' });
    expect(workflowRun.success).toBe(true);
    expect(controlPlane.runWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'browser-read-smoke',
      origin: 'web',
    }));

    const taskRun = await runSavedAutomation(controlPlane, 'task-agent-1');
    expect(taskRun.success).toBe(true);
    expect(controlPlane.runTask).toHaveBeenCalledWith('task-agent-1');

    const deleteResult = deleteSavedAutomation(controlPlane, 'browser-read-smoke');
    expect(deleteResult.success).toBe(true);
    expect(controlPlane.deleteTask).toHaveBeenCalledWith('task-linked-1');
    expect(controlPlane.deleteWorkflow).toHaveBeenCalledWith('browser-read-smoke');
  });
});
