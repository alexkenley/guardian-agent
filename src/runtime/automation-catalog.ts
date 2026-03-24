import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { ScheduledTaskDefinition } from './scheduled-tasks.js';

export type AutomationCatalogKind = 'workflow' | 'assistant_task' | 'task';

export interface SavedAutomationCatalogEntry {
  id: string;
  name: string;
  description: string;
  kind: AutomationCatalogKind;
  enabled: boolean;
  workflow?: AssistantConnectorPlaybookDefinition;
  task?: ScheduledTaskDefinition;
}

export function buildSavedAutomationCatalogEntries(
  workflows: AssistantConnectorPlaybookDefinition[],
  tasks: ScheduledTaskDefinition[],
): SavedAutomationCatalogEntry[] {
  const matchedTaskIds = new Set<string>();
  const entries: SavedAutomationCatalogEntry[] = [];

  for (const workflow of workflows) {
    const linkedTask = tasks.find((task) => (
      task.type === 'playbook'
      && task.target === workflow.id
    ));
    if (linkedTask?.id) {
      matchedTaskIds.add(linkedTask.id);
    }
    entries.push({
      id: workflow.id || linkedTask?.id || '',
      name: workflow.name || linkedTask?.name || 'Unnamed automation',
      description: workflow.description || '',
      kind: 'workflow',
      enabled: workflow.enabled !== false,
      workflow,
      ...(linkedTask ? { task: linkedTask } : {}),
    });
  }

  for (const task of tasks) {
    if (!task.id || matchedTaskIds.has(task.id)) continue;
    entries.push({
      id: task.id,
      name: task.name || task.id,
      description: task.description || '',
      kind: task.type === 'agent' ? 'assistant_task' : 'task',
      enabled: task.enabled !== false,
      task,
    });
  }

  return entries.filter((entry) => Boolean(entry.id && entry.name));
}

export function selectSavedAutomationCatalogEntry(
  catalog: SavedAutomationCatalogEntry[],
  requestedName: string,
): SavedAutomationCatalogEntry | null {
  const normalized = normalizeAutomationCatalogLookupKey(requestedName);
  const exact = catalog.find((entry) => (
    normalizeAutomationCatalogLookupKey(entry.name) === normalized
    || normalizeAutomationCatalogLookupKey(entry.id) === normalized
  ));
  if (exact) return exact;

  const partial = catalog.filter((entry) => (
    normalizeAutomationCatalogLookupKey(entry.name).includes(normalized)
    || normalizeAutomationCatalogLookupKey(entry.id).includes(normalized)
  ));
  return partial.length === 1 ? partial[0] : null;
}

export function normalizeAutomationCatalogLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
