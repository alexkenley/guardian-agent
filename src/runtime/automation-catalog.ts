import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { BuiltinAutomationExample } from './builtin-packs.js';
import type { ScheduledTaskDefinition, ScheduledTaskPreset } from './scheduled-tasks.js';

export type AutomationCatalogKind = 'workflow' | 'assistant_task' | 'task';
export type AutomationCatalogSource = 'saved_workflow' | 'saved_task' | 'builtin_example';

export interface SavedAutomationCatalogEntry {
  id: string;
  name: string;
  description: string;
  kind: AutomationCatalogKind;
  enabled: boolean;
  source?: AutomationCatalogSource;
  builtin?: boolean;
  category?: string;
  templateId?: string;
  presetId?: string;
  workflow?: AssistantConnectorPlaybookDefinition;
  task?: ScheduledTaskDefinition;
}

interface AutomationCatalogTemplateInput extends Pick<BuiltinAutomationExample, 'id' | 'category' | 'playbooks'> {
  materialized: boolean;
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
      source: 'saved_workflow',
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
      source: 'saved_task',
      task,
    });
  }

  return entries.filter((entry) => Boolean(entry.id && entry.name));
}

export function buildAutomationCatalogEntries(
  workflows: AssistantConnectorPlaybookDefinition[],
  tasks: ScheduledTaskDefinition[],
  templates: AutomationCatalogTemplateInput[] = [],
  presets: ScheduledTaskPreset[] = [],
): SavedAutomationCatalogEntry[] {
  const entries = buildSavedAutomationCatalogEntries(workflows, tasks);
  const workflowById = new Map(
    workflows.map((workflow) => [workflow.id, cloneWorkflow(workflow)]),
  );
  const workflowCategoryById = new Map<string, string>();

  for (const template of templates) {
    for (const playbook of template.playbooks) {
      workflowCategoryById.set(playbook.id, template.category);
      if (!workflowById.has(playbook.id)) {
        workflowById.set(playbook.id, cloneWorkflow(playbook));
      }
    }
  }

  const entryIds = new Set(entries.map((entry) => entry.id));
  const workflowIds = new Set(entries
    .map((entry) => entry.workflow?.id)
    .filter((id): id is string => Boolean(id)));
  const materializedPresetIds = new Set(tasks
    .map((task) => task.presetId)
    .filter((presetId): presetId is string => Boolean(presetId)));
  const materializedPresetKeys = new Set(tasks.map(buildPresetInstallationKey));

  for (const template of templates) {
    if (template.materialized) continue;
    for (const playbook of template.playbooks) {
      if (workflowIds.has(playbook.id) || entryIds.has(playbook.id)) continue;
      entries.push({
        id: playbook.id,
        name: playbook.name,
        description: playbook.description || '',
        kind: 'workflow',
        enabled: false,
        source: 'builtin_example',
        builtin: true,
        category: template.category,
        templateId: template.id,
        workflow: {
          ...cloneWorkflow(playbook),
          enabled: false,
        },
      });
      entryIds.add(playbook.id);
      workflowIds.add(playbook.id);
    }
  }

  for (const preset of presets) {
    if (materializedPresetIds.has(preset.id) || materializedPresetKeys.has(buildPresetInstallationKey(preset))) {
      continue;
    }
    if (entryIds.has(preset.id)) continue;

    const syntheticTask = buildSyntheticTaskFromPreset(preset);
    const workflow = preset.type === 'playbook'
      ? workflowById.get(preset.target)
      : undefined;
    if (preset.type === 'playbook' && !workflow) continue;

    entries.push({
      id: preset.id,
      name: preset.name,
      description: preset.description || workflow?.description || '',
      kind: preset.type === 'agent' ? 'assistant_task' : (preset.type === 'playbook' ? 'workflow' : 'task'),
      enabled: false,
      source: 'builtin_example',
      builtin: true,
      category: workflow ? workflowCategoryById.get(workflow.id) : undefined,
      presetId: preset.id,
      ...(workflow ? {
        workflow: {
          ...cloneWorkflow(workflow),
          enabled: false,
        },
      } : {}),
      task: syntheticTask,
    });
    entryIds.add(preset.id);
  }

  return entries;
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

function buildPresetInstallationKey(task: Pick<ScheduledTaskDefinition, 'name' | 'target' | 'type'>): string {
  return [task.name, task.target, task.type]
    .map((value) => normalizeAutomationCatalogLookupKey(String(value || '')))
    .join('::');
}

function buildSyntheticTaskFromPreset(preset: ScheduledTaskPreset): ScheduledTaskDefinition {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    type: preset.type,
    target: preset.target,
    presetId: preset.id,
    ...(preset.args ? { args: { ...preset.args } } : {}),
    ...(preset.prompt ? { prompt: preset.prompt } : {}),
    ...(preset.channel ? { channel: preset.channel } : {}),
    ...(preset.userId ? { userId: preset.userId } : {}),
    ...(typeof preset.deliver === 'boolean' ? { deliver: preset.deliver } : {}),
    ...(typeof preset.runOnce === 'boolean' ? { runOnce: preset.runOnce } : {}),
    ...(preset.cron ? { cron: preset.cron } : {}),
    ...(preset.eventTrigger ? { eventTrigger: { ...preset.eventTrigger } } : {}),
    enabled: false,
    createdAt: 0,
    scopeHash: `builtin-preset:${preset.id}`,
    maxRunsPerWindow: 1,
    dailySpendCap: 0,
    providerSpendCap: 0,
    consecutiveFailureCount: 0,
    consecutiveDeniedCount: 0,
    runCount: 0,
    ...(preset.emitEvent ? { emitEvent: preset.emitEvent } : {}),
    ...(preset.outputHandling ? { outputHandling: { ...preset.outputHandling } } : {}),
  };
}

function cloneWorkflow(workflow: AssistantConnectorPlaybookDefinition): AssistantConnectorPlaybookDefinition {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step })),
    ...(workflow.outputHandling ? { outputHandling: { ...workflow.outputHandling } } : {}),
  };
}
