import { describe, expect, it, vi } from 'vitest';
import { saveAutomationDefinition, type AutomationSaveControlPlane } from './automation-save.js';

function makeControlPlane(): AutomationSaveControlPlane {
  return {
    upsertWorkflow: vi.fn(() => ({ success: true, message: 'Workflow saved.' })),
    createTask: vi.fn((input) => ({
      success: true,
      message: 'Task created.',
      task: {
        id: 'task-created-1',
        name: input.name,
        type: input.type,
        target: input.target,
        enabled: input.enabled !== false,
        createdAt: 1,
        scopeHash: 'scope',
        maxRunsPerWindow: input.maxRunsPerWindow ?? 1,
        dailySpendCap: input.dailySpendCap ?? 0,
        providerSpendCap: input.providerSpendCap ?? 0,
        consecutiveFailureCount: 0,
        consecutiveDeniedCount: 0,
        runCount: 0,
      },
    })),
    updateTask: vi.fn(() => ({ success: true, message: 'Task updated.' })),
    deleteTask: vi.fn(() => ({ success: true, message: 'Task deleted.' })),
  };
}

describe('automation-save', () => {
  it('saves workflows and creates or removes linked schedules through one backend mutation', () => {
    const controlPlane = makeControlPlane();

    const scheduled = saveAutomationDefinition(controlPlane, {
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      description: 'Reads a page.',
      enabled: true,
      kind: 'workflow',
      mode: 'sequential',
      steps: [
        { id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
      ],
      schedule: { enabled: true, cron: '0 8 * * 1', runOnce: false },
      outputHandling: { notify: 'off', sendToSecurity: 'off', persistArtifacts: 'run_history_only' },
    });

    expect(scheduled).toMatchObject({ success: true, automationId: 'browser-read-smoke', taskId: 'task-created-1' });
    expect(controlPlane.upsertWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      enabled: true,
    }));
    expect(controlPlane.createTask).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Browser Read Smoke',
      type: 'playbook',
      target: 'browser-read-smoke',
      cron: '0 8 * * 1',
    }));

    const unscheduled = saveAutomationDefinition(controlPlane, {
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      enabled: true,
      kind: 'workflow',
      mode: 'sequential',
      steps: [
        { id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
      ],
      existingTaskId: 'task-linked-1',
      schedule: { enabled: false },
    });

    expect(unscheduled).toMatchObject({ success: true, automationId: 'browser-read-smoke' });
    expect(controlPlane.deleteTask).toHaveBeenCalledWith('task-linked-1');
  });

  it('passes workflow signatures through the shared automation save path', () => {
    const controlPlane = makeControlPlane();

    const result = saveAutomationDefinition(controlPlane, {
      id: 'signed-browser-read',
      name: 'Signed Browser Read',
      enabled: true,
      kind: 'workflow',
      mode: 'sequential',
      signature: 'sig-123',
      steps: [
        { id: 'step-1', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
      ],
      schedule: { enabled: false },
    });

    expect(result).toMatchObject({ success: true, automationId: 'signed-browser-read' });
    expect(controlPlane.upsertWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'signed-browser-read',
      signature: 'sig-123',
    }));
  });

  it('saves assistant automations through task create/update without UI-side branching', () => {
    const controlPlane = makeControlPlane();

    const result = saveAutomationDefinition(controlPlane, {
      id: 'inbox-triage',
      name: 'Inbox Triage',
      description: 'Daily inbox review.',
      enabled: true,
      kind: 'assistant_task',
      existingTaskId: 'task-agent-1',
      task: {
        target: 'default',
        prompt: 'Summarize my inbox and draft replies.',
        channel: 'scheduled',
        deliver: true,
        llmProvider: 'ollama',
      },
      schedule: { enabled: true, cron: '0 8 * * *', runOnce: false },
      emitEvent: 'inbox_triage_completed',
    });

    expect(result).toMatchObject({ success: true, automationId: 'task-agent-1', taskId: 'task-agent-1' });
    expect(controlPlane.updateTask).toHaveBeenCalledWith('task-agent-1', expect.objectContaining({
      name: 'Inbox Triage',
      type: 'agent',
      target: 'default',
      prompt: 'Summarize my inbox and draft replies.',
      channel: 'scheduled',
      cron: '0 8 * * *',
      args: { llmProvider: 'ollama' },
    }));
  });

  it('creates manual assistant automations with an event trigger instead of a cron schedule', () => {
    const controlPlane = makeControlPlane();

    const result = saveAutomationDefinition(controlPlane, {
      id: 'company-homepage-collector',
      name: 'Company Homepage Collector',
      description: 'Reviews company homepages on demand.',
      enabled: true,
      kind: 'assistant_task',
      task: {
        target: 'default',
        prompt: 'Read ./companies.csv, inspect each homepage, and write ./tmp/company-homepages.json.',
        channel: 'scheduled',
        deliver: false,
      },
      schedule: { enabled: false },
    });

    expect(result).toMatchObject({ success: true, automationId: 'task-created-1', taskId: 'task-created-1' });
    expect(controlPlane.createTask).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Company Homepage Collector',
      type: 'agent',
      target: 'default',
      eventTrigger: { eventType: 'automation:manual:company-homepage-collector' },
    }));
  });

  it('creates manual standalone tool automations with an event trigger instead of a cron schedule', () => {
    const controlPlane = makeControlPlane();

    const result = saveAutomationDefinition(controlPlane, {
      id: 'example-links-snapshot',
      name: 'Example Links Snapshot',
      enabled: true,
      kind: 'standalone_task',
      task: {
        target: 'browser_links',
        args: { url: 'https://example.com' },
      },
      schedule: { enabled: false },
    });

    expect(result).toMatchObject({ success: true, automationId: 'task-created-1', taskId: 'task-created-1' });
    expect(controlPlane.createTask).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Example Links Snapshot',
      type: 'tool',
      target: 'browser_links',
      eventTrigger: { eventType: 'automation:manual:example-links-snapshot' },
    }));
  });

  it('creates standalone tool tasks when editing a task-only automation is not applicable', () => {
    const controlPlane = makeControlPlane();

    const result = saveAutomationDefinition(controlPlane, {
      id: 'top-links-report',
      name: 'Top Links Report',
      description: 'Fetches links from a page.',
      enabled: false,
      kind: 'standalone_task',
      task: {
        target: 'browser_links',
        args: { url: 'https://example.com' },
      },
      schedule: { enabled: true, cron: '0 9 * * 1', runOnce: false },
    });

    expect(result).toMatchObject({ success: true, automationId: 'task-created-1', taskId: 'task-created-1' });
    expect(controlPlane.createTask).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Top Links Report',
      type: 'tool',
      target: 'browser_links',
      args: { url: 'https://example.com' },
      cron: '0 9 * * 1',
      enabled: false,
    }));
  });
});
