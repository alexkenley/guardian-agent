import { describe, expect, it } from 'vitest';
import {
  buildAutomationCatalogEntries,
  buildSavedAutomationCatalogEntries,
  selectSavedAutomationCatalogEntry,
} from './automation-catalog.js';
import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { ScheduledTaskDefinition, ScheduledTaskPreset } from './scheduled-tasks.js';

describe('buildSavedAutomationCatalogEntries', () => {
  it('merges workflows with linked playbook tasks and keeps standalone task automations', () => {
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
        type: 'agent',
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

    const catalog = buildSavedAutomationCatalogEntries(workflows, tasks);

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({
      id: 'browser-read-smoke',
      name: 'Browser Read Smoke',
      kind: 'workflow',
      workflow: { id: 'browser-read-smoke' },
      task: { id: 'task-linked-1', target: 'browser-read-smoke' },
    });
    expect(catalog[1]).toMatchObject({
      id: 'task-agent-1',
      name: 'Inbox Triage',
      kind: 'assistant_task',
      task: { id: 'task-agent-1' },
    });
  });
});

describe('buildAutomationCatalogEntries', () => {
  it('adds built-in starter examples without duplicating materialized automations', () => {
    const workflows: AssistantConnectorPlaybookDefinition[] = [];
    const tasks: ScheduledTaskDefinition[] = [];
    const templates = [
      {
        id: 'browser-starters',
        category: 'system',
        materialized: false,
        playbooks: [
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
        ],
      },
    ];
    const presets: ScheduledTaskPreset[] = [
      {
        id: 'browser-read-weekly',
        name: 'Weekly Browser Read',
        description: 'Run the browser read starter every Monday.',
        type: 'playbook',
        target: 'browser-read-smoke',
        cron: '0 8 * * 1',
      },
      {
        id: 'assistant-inbox-triage',
        name: 'Inbox Triage',
        description: 'Review high-priority inbox items.',
        type: 'agent',
        target: 'default',
        prompt: 'Check the inbox.',
        channel: 'scheduled',
      },
    ];

    const catalog = buildAutomationCatalogEntries(workflows, tasks, templates, presets);

    expect(catalog).toHaveLength(3);
    expect(catalog[0]).toMatchObject({
      id: 'browser-read-smoke',
      source: 'builtin_example',
      builtin: true,
      category: 'system',
      workflow: { id: 'browser-read-smoke', enabled: false },
    });
    expect(catalog[1]).toMatchObject({
      id: 'browser-read-weekly',
      source: 'builtin_example',
      builtin: true,
      kind: 'workflow',
      workflow: { id: 'browser-read-smoke', enabled: false },
      task: { id: 'browser-read-weekly', cron: '0 8 * * 1', enabled: false },
    });
    expect(catalog[2]).toMatchObject({
      id: 'assistant-inbox-triage',
      source: 'builtin_example',
      builtin: true,
      kind: 'assistant_task',
      task: { id: 'assistant-inbox-triage', target: 'default', enabled: false },
    });
  });
});

describe('selectSavedAutomationCatalogEntry', () => {
  it('matches saved automations by exact or partial name', () => {
    const catalog = [
      {
        id: 'browser-read-smoke',
        name: 'Browser Read Smoke',
        description: '',
        kind: 'workflow' as const,
        enabled: true,
      },
      {
        id: 'inbox-triage',
        name: 'Inbox Triage',
        description: '',
        kind: 'assistant_task' as const,
        enabled: true,
      },
    ];

    expect(selectSavedAutomationCatalogEntry(catalog, 'Browser Read Smoke')?.id).toBe('browser-read-smoke');
    expect(selectSavedAutomationCatalogEntry(catalog, 'Inbox')?.id).toBe('inbox-triage');
  });
});
