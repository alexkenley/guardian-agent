import { describe, expect, it, vi } from 'vitest';
import {
  createAutomationFromCatalogEntry,
  type AutomationCatalogActionControlPlane,
} from './automation-catalog-actions.js';

function makeControlPlane(): AutomationCatalogActionControlPlane {
  const catalog = [
    {
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      description: 'Reads a page.',
      kind: 'workflow' as const,
      enabled: true,
      source: 'saved_workflow' as const,
      workflow: {
        id: 'browser-read-smoke',
        name: 'Browser Read Smoke',
        enabled: true,
        mode: 'sequential' as const,
        description: 'Reads a page.',
        schedule: '0 8 * * 1',
        steps: [
          { id: 'navigate', type: 'tool' as const, packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
        ],
      },
      task: {
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
    },
    {
      id: 'task-agent-1',
      name: 'Inbox Triage',
      description: 'Daily inbox review.',
      kind: 'assistant_task' as const,
      enabled: true,
      source: 'saved_task' as const,
      task: {
        id: 'task-agent-1',
        name: 'Inbox Triage',
        type: 'agent' as const,
        target: 'default',
        prompt: 'Summarize high-priority inbox.',
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
    },
    {
      id: 'builtin-browser-read',
      name: 'Builtin Browser Read',
      description: 'Starter browser workflow.',
      kind: 'workflow' as const,
      enabled: false,
      builtin: true,
      source: 'builtin_example' as const,
      templateId: 'builtin-browser',
      workflow: {
        id: 'builtin-browser-read',
        name: 'Builtin Browser Read',
        enabled: false,
        mode: 'sequential' as const,
        description: 'Starter browser workflow.',
        steps: [
          { id: 'navigate', type: 'tool' as const, packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
        ],
      },
    },
    {
      id: 'network-watch',
      name: 'Network Watch',
      description: 'Built-in preset.',
      kind: 'task' as const,
      enabled: false,
      builtin: true,
      source: 'builtin_example' as const,
      presetId: 'network-watch',
      task: {
        id: 'network-watch',
        name: 'Network Watch',
        type: 'tool' as const,
        target: 'net_arp_scan',
        cron: '*/30 * * * *',
        enabled: false,
        createdAt: 1,
        scopeHash: 'scope-c',
        maxRunsPerWindow: 1,
        dailySpendCap: 0,
        providerSpendCap: 0,
        consecutiveFailureCount: 0,
        consecutiveDeniedCount: 0,
        runCount: 0,
      },
    },
  ];

  return {
    listCatalog: vi.fn(() => catalog),
    upsertWorkflow: vi.fn(() => ({ success: true, message: 'Workflow saved.' })),
    deleteWorkflow: vi.fn(() => ({ success: true, message: 'Workflow deleted.' })),
    createTask: vi.fn((input) => ({
      success: true,
      message: 'Task created.',
      task: {
        id: `${String(input.name || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: String(input.name || 'Task'),
        type: input.type,
        target: input.target,
        ...(input.cron ? { cron: input.cron } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.eventTrigger ? { eventTrigger: input.eventTrigger } : {}),
        enabled: input.enabled !== false,
        createdAt: 1,
        scopeHash: 'scope-new',
        maxRunsPerWindow: input.maxRunsPerWindow ?? 1,
        dailySpendCap: input.dailySpendCap ?? 0,
        providerSpendCap: input.providerSpendCap ?? 0,
        consecutiveFailureCount: 0,
        consecutiveDeniedCount: 0,
        runCount: 0,
      },
    })),
    createFromPresetExample: vi.fn(() => ({
      success: true,
      message: 'Installed preset.',
      task: {
        id: 'task-created-preset-example',
        name: 'Network Watch',
        type: 'tool' as const,
        target: 'net_arp_scan',
        enabled: false,
        createdAt: 1,
        scopeHash: 'scope-preset',
        maxRunsPerWindow: 1,
        dailySpendCap: 0,
        providerSpendCap: 0,
        consecutiveFailureCount: 0,
        consecutiveDeniedCount: 0,
        runCount: 0,
      },
    })),
    createFromTemplateExample: vi.fn(() => ({ success: true, message: 'Created starter example.' })),
  };
}

describe('automation-catalog-actions', () => {
  it('creates a copy of saved workflows and linked schedules without copying the original schedule field', () => {
    const controlPlane = makeControlPlane();

    const result = createAutomationFromCatalogEntry(controlPlane, 'browser-read-smoke');

    expect(result).toMatchObject({
      success: true,
      action: 'copied',
      automationId: 'browser-read-smoke-copy',
      automationName: 'Browser Read Smoke (copy)',
    });
    expect(controlPlane.upsertWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'browser-read-smoke-copy',
      name: 'Browser Read Smoke (copy)',
      enabled: false,
    }));
    const clonedWorkflow = vi.mocked(controlPlane.upsertWorkflow).mock.calls[0]?.[0];
    expect(Object.prototype.hasOwnProperty.call(clonedWorkflow ?? {}, 'schedule')).toBe(false);
    expect(controlPlane.createTask).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Browser Read Smoke (copy)',
      type: 'playbook',
      target: 'browser-read-smoke-copy',
      cron: '0 8 * * 1',
      enabled: false,
    }));
  });

  it('creates a copy of saved task automations through task creation and strips manual trigger event ids', () => {
    const controlPlane = makeControlPlane();

    const result = createAutomationFromCatalogEntry(controlPlane, 'task-agent-1');

    expect(result).toMatchObject({
      success: true,
      action: 'copied',
      automationName: 'Inbox Triage (copy)',
    });
    expect(controlPlane.createTask).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Inbox Triage (copy)',
      type: 'agent',
      target: 'default',
      enabled: false,
    }));
    expect(controlPlane.createTask).toHaveBeenCalledWith(expect.not.objectContaining({
      eventTrigger: expect.anything(),
    }));
  });

  it('creates saved automations from builtin template and preset examples', () => {
    const controlPlane = makeControlPlane();

    const templateResult = createAutomationFromCatalogEntry(controlPlane, 'builtin-browser-read');
    const presetResult = createAutomationFromCatalogEntry(controlPlane, 'network-watch');

    expect(templateResult).toMatchObject({
      success: true,
      action: 'created',
      automationId: 'builtin-browser-read',
      message: "Created automation 'Builtin Browser Read' from the starter example.",
    });
    expect(controlPlane.createFromTemplateExample).toHaveBeenCalledWith('builtin-browser');

    expect(presetResult).toMatchObject({
      success: true,
      action: 'created',
      automationId: 'task-created-preset-example',
      message: "Created automation 'Network Watch' from the starter example.",
    });
    expect(controlPlane.createFromPresetExample).toHaveBeenCalledWith('network-watch');
  });
});
