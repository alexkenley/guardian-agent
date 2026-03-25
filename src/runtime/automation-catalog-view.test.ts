import { describe, expect, it } from 'vitest';
import { buildAutomationCatalogEntries } from './automation-catalog.js';
import { buildAutomationCatalogViewEntries } from './automation-catalog-view.js';
import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { ScheduledTaskDefinition, ScheduledTaskPreset } from './scheduled-tasks.js';

describe('automation-catalog-view', () => {
  it('builds backend-owned view entries for workflows, assistant tasks, and builtin starters', () => {
    const workflows: AssistantConnectorPlaybookDefinition[] = [
      {
        id: 'browser-read-smoke',
        name: 'Browser Read Smoke',
        enabled: true,
        mode: 'sequential',
        description: 'Read a page and list links.',
        steps: [
          { id: 'navigate', type: 'tool', packId: '', toolName: 'browser_navigate', args: { url: 'https://example.com' } },
        ],
      },
    ];
    const tasks: ScheduledTaskDefinition[] = [
      {
        id: 'task-linked-1',
        name: 'Browser Read Smoke',
        type: 'playbook',
        target: 'browser-read-smoke',
        cron: '0 8 * * 1',
        enabled: true,
        runCount: 4,
        createdAt: 1,
        scopeHash: 'scope-a',
        maxRunsPerWindow: 1,
        dailySpendCap: 0,
        providerSpendCap: 0,
        consecutiveFailureCount: 0,
        consecutiveDeniedCount: 0,
      },
      {
        id: 'task-agent-1',
        name: 'Inbox Triage',
        type: 'agent',
        target: 'default',
        prompt: 'You are executing a scheduled Guardian automation.\n\nOperator request: Check the high-priority inbox and draft replies.',
        channel: 'scheduled',
        deliver: true,
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
      {
        id: 'task-web-fetch-1',
        name: 'Fetch Status',
        type: 'tool',
        target: 'web_fetch',
        args: { url: 'https://example.com/status' },
        enabled: true,
        createdAt: 1,
        scopeHash: 'scope-c',
        maxRunsPerWindow: 1,
        dailySpendCap: 0,
        providerSpendCap: 0,
        consecutiveFailureCount: 0,
        consecutiveDeniedCount: 0,
        runCount: 0,
      },
    ];
    const templates = [
      {
        id: 'browser-starters',
        category: 'browser',
        materialized: false,
        playbooks: workflows,
      },
    ];
    const presets: ScheduledTaskPreset[] = [
      {
        id: 'assistant-browser-report',
        name: 'Assistant Browser Report',
        description: 'Review browser output each Monday.',
        type: 'agent',
        target: 'default',
        prompt: 'Check browser automations.',
        channel: 'scheduled',
      },
    ];
    const toolMetadata = [
      { name: 'browser_navigate', category: 'browser' as const, description: 'Open a page.' },
      { name: 'web_fetch', category: 'web' as const, shortDescription: 'Fetch a web page.' },
    ];

    const catalog = buildAutomationCatalogEntries(workflows, tasks, templates, presets);
    const view = buildAutomationCatalogViewEntries(catalog, toolMetadata);

    expect(view).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'browser-read-smoke',
        category: 'browser',
        kind: 'single',
        sourceKind: 'playbook',
        cron: '0 8 * * 1',
        scheduleEnabled: true,
        taskId: 'task-linked-1',
        runCount: 4,
      }),
      expect.objectContaining({
        id: 'task-agent-1',
        kind: 'assistant',
        category: 'assistant',
        description: 'Check the high-priority inbox and draft replies.',
        sourceKind: 'task',
        agentChannel: 'scheduled',
        agentDeliver: true,
      }),
      expect.objectContaining({
        id: 'task-web-fetch-1',
        kind: 'single',
        category: 'web',
        description: 'Fetch a web page.',
        sourceKind: 'task',
      }),
      expect.objectContaining({
        id: 'assistant-browser-report',
        builtin: true,
        sourceKind: 'example',
        kind: 'assistant',
      }),
    ]));
  });
});
