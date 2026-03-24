import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { ConnectorPlaybookRunInput, ConnectorPlaybookRunResult } from './connectors.js';
import {
  buildAutomationCatalogEntries,
  buildSavedAutomationCatalogEntries,
  type SavedAutomationCatalogEntry,
} from './automation-catalog.js';
import type { BuiltinTemplate } from './builtin-packs.js';
import type {
  ScheduledTaskCreateInput,
  ScheduledTaskDefinition,
  ScheduledTaskHistoryEntry,
  ScheduledTaskPreset,
  ScheduledTaskUpdateInput,
} from './scheduled-tasks.js';
import {
  deleteSavedAutomation,
  runSavedAutomation,
  setSavedAutomationEnabled,
  type AutomationManagerControlPlane,
} from './automation-manager.js';

interface AutomationWorkflowControl {
  list(): AssistantConnectorPlaybookDefinition[];
  upsert(playbook: AssistantConnectorPlaybookDefinition): { success: boolean; message: string };
  delete(playbookId: string): { success: boolean; message: string };
  run(input: ConnectorPlaybookRunInput): Promise<ConnectorPlaybookRunResult> | ConnectorPlaybookRunResult;
}

interface AutomationTaskControl {
  list(): ScheduledTaskDefinition[];
  get(id: string): ScheduledTaskDefinition | null;
  create(input: ScheduledTaskCreateInput): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  update(id: string, input: ScheduledTaskUpdateInput): { success: boolean; message: string };
  delete(id: string): { success: boolean; message: string };
  runNow(id: string): Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
  presets(): ScheduledTaskPreset[];
  installPreset(presetId: string): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  history(): ScheduledTaskHistoryEntry[];
}

interface AutomationTemplateControl {
  list(): Array<Pick<BuiltinTemplate, 'id' | 'category' | 'playbooks'> & { installed: boolean }>;
}

export interface AutomationRuntimeServiceOptions {
  workflows: AutomationWorkflowControl;
  tasks: AutomationTaskControl;
  templates?: AutomationTemplateControl;
  onWorkflowSaved?: (playbook: AssistantConnectorPlaybookDefinition) => void;
  onWorkflowRunResult?: (
    result: ConnectorPlaybookRunResult,
    input: ConnectorPlaybookRunInput,
  ) => Promise<void> | void;
}

export interface AutomationRuntimeService {
  listAutomationCatalog(): SavedAutomationCatalogEntry[];
  listWorkflows(): AssistantConnectorPlaybookDefinition[];
  upsertWorkflow(playbook: AssistantConnectorPlaybookDefinition): { success: boolean; message: string };
  deleteWorkflow(playbookId: string): { success: boolean; message: string };
  runWorkflow(input: ConnectorPlaybookRunInput): Promise<ConnectorPlaybookRunResult>;
  listTasks(): ScheduledTaskDefinition[];
  getTask(id: string): ScheduledTaskDefinition | null;
  createTask(input: ScheduledTaskCreateInput): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  updateTask(id: string, input: ScheduledTaskUpdateInput): { success: boolean; message: string };
  deleteTask(id: string): { success: boolean; message: string };
  runTaskNow(id: string): Promise<{ success: boolean; message: string }>;
  listTaskPresets(): ScheduledTaskPreset[];
  installTaskPreset(presetId: string): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  listTaskHistory(): ScheduledTaskHistoryEntry[];
  listSavedAutomations(): SavedAutomationCatalogEntry[];
  setSavedAutomationEnabled(automationId: string, enabled: boolean): { success: boolean; message: string };
  deleteSavedAutomation(automationId: string): { success: boolean; message: string };
  runSavedAutomation(input: {
    automationId: string;
    dryRun?: boolean;
    origin?: ConnectorPlaybookRunInput['origin'];
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  }): Promise<Record<string, unknown>>;
  createExecutorControlPlane(): {
    listAutomations: () => SavedAutomationCatalogEntry[];
    setAutomationEnabled: (automationId: string, enabled: boolean) => { success: boolean; message: string };
    deleteAutomation: (automationId: string) => { success: boolean; message: string };
    runAutomation: (input: {
      automationId: string;
      dryRun?: ConnectorPlaybookRunInput['dryRun'];
      origin?: ConnectorPlaybookRunInput['origin'];
      agentId?: string;
      userId?: string;
      channel?: string;
      requestedBy?: string;
    }) => Promise<Record<string, unknown>>;
    listWorkflows: () => Array<{
      id: string;
      name: string;
      enabled: boolean;
      mode: string;
      description?: string;
      schedule?: string;
      steps?: Array<Record<string, unknown>>;
    }>;
    upsertWorkflow: (workflow: Record<string, unknown>) => { success: boolean; message: string };
    deleteWorkflow: (workflowId: string) => { success: boolean; message: string };
    runWorkflow: (input: {
      workflowId: string;
      dryRun?: ConnectorPlaybookRunInput['dryRun'];
      origin?: ConnectorPlaybookRunInput['origin'];
      agentId?: string;
      userId?: string;
      channel?: string;
      requestedBy?: string;
    }) => Promise<{ success: boolean; message: string; status: string; run?: unknown }>;
    listTasks: () => ScheduledTaskDefinition[];
    createTask: (input: Record<string, unknown>) => { success: boolean; message: string; task?: ScheduledTaskDefinition };
    updateTask: (id: string, input: Record<string, unknown>) => { success: boolean; message: string };
    runTask: (id: string) => Promise<{ success: boolean; message: string }>;
    deleteTask: (id: string) => { success: boolean; message: string };
  };
}

export function createAutomationRuntimeService(
  options: AutomationRuntimeServiceOptions,
): AutomationRuntimeService {
  const service: AutomationRuntimeService = {
    listAutomationCatalog: () => buildAutomationCatalogEntries(
      service.listWorkflows(),
      service.listTasks(),
      options.templates?.list().map(cloneCatalogTemplate) ?? [],
      service.listTaskPresets(),
    ),
    listWorkflows: () => options.workflows.list().map(cloneWorkflow),
    upsertWorkflow: (playbook) => {
      const normalized = cloneWorkflow(playbook);
      const result = options.workflows.upsert(normalized);
      if (result.success) {
        options.onWorkflowSaved?.(normalized);
      }
      return result;
    },
    deleteWorkflow: (playbookId) => {
      const linkedTaskIds = options.tasks.list()
        .filter((task) => task.type === 'playbook' && task.target === playbookId)
        .map((task) => task.id);
      const result = options.workflows.delete(playbookId);
      if (result.success) {
        for (const taskId of linkedTaskIds) {
          options.tasks.delete(taskId);
        }
      }
      return result;
    },
    runWorkflow: async (input) => {
      const result = await options.workflows.run({ ...input });
      await options.onWorkflowRunResult?.(result, input);
      return result;
    },
    listTasks: () => options.tasks.list().map(cloneTask),
    getTask: (id) => {
      const task = options.tasks.get(id);
      return task ? cloneTask(task) : null;
    },
    createTask: (input) => options.tasks.create(cloneTaskCreateInput(input)),
    updateTask: (id, input) => options.tasks.update(id, cloneTaskUpdateInput(input)),
    deleteTask: (id) => options.tasks.delete(id),
    runTaskNow: async (id) => options.tasks.runNow(id),
    listTaskPresets: () => options.tasks.presets().map(cloneTaskPreset),
    installTaskPreset: (presetId) => options.tasks.installPreset(presetId),
    listTaskHistory: () => options.tasks.history().map(cloneTaskHistoryEntry),
    listSavedAutomations: () => importCatalogEntries(service),
    setSavedAutomationEnabled: (automationId, enabled) => (
      setSavedAutomationEnabled(asManagerControlPlane(service), automationId, enabled)
    ),
    deleteSavedAutomation: (automationId) => (
      deleteSavedAutomation(asManagerControlPlane(service), automationId)
    ),
    runSavedAutomation: async (input) => (
      runSavedAutomation(asManagerControlPlane(service), input.automationId, input)
    ),
    createExecutorControlPlane: () => ({
      listAutomations: () => service.listAutomationCatalog().map(cloneCatalogEntry),
      setAutomationEnabled: (automationId, enabled) => service.setSavedAutomationEnabled(automationId, enabled),
      deleteAutomation: (automationId) => service.deleteSavedAutomation(automationId),
      runAutomation: async (input) => service.runSavedAutomation(input),
      listWorkflows: () => service.listWorkflows().map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        enabled: workflow.enabled,
        mode: workflow.mode,
        description: workflow.description,
        schedule: workflow.schedule,
        steps: workflow.steps.map((step) => ({ ...step })) as Array<Record<string, unknown>>,
      })),
      upsertWorkflow: (workflow) => service.upsertWorkflow(workflow as unknown as AssistantConnectorPlaybookDefinition),
      deleteWorkflow: (workflowId) => service.deleteWorkflow(workflowId),
      runWorkflow: async (input) => service.runWorkflow({
        playbookId: input.workflowId,
        dryRun: input.dryRun,
        origin: input.origin ?? 'assistant',
        agentId: input.agentId,
        userId: input.userId,
        channel: input.channel,
        requestedBy: input.requestedBy,
      }),
      listTasks: () => service.listTasks(),
      createTask: (input) => service.createTask(input as unknown as ScheduledTaskCreateInput),
      updateTask: (id, input) => service.updateTask(id, input as unknown as ScheduledTaskUpdateInput),
      runTask: async (id) => service.runTaskNow(id),
      deleteTask: (id) => service.deleteTask(id),
    }),
  };
  return service;
}

function asManagerControlPlane(service: AutomationRuntimeService): AutomationManagerControlPlane {
  return {
    listWorkflows: () => service.listWorkflows(),
    listTasks: () => service.listTasks(),
    upsertWorkflow: (workflow) => service.upsertWorkflow(workflow),
    updateTask: (id, input) => service.updateTask(id, input as ScheduledTaskUpdateInput),
    deleteWorkflow: (workflowId) => service.deleteWorkflow(workflowId),
    deleteTask: (id) => service.deleteTask(id),
    runWorkflow: async (input) => service.runWorkflow({
      playbookId: input.workflowId,
      dryRun: input.dryRun,
      origin: input.origin ?? 'assistant',
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      requestedBy: input.requestedBy,
    }),
    runTask: async (id) => service.runTaskNow(id),
  };
}

function importCatalogEntries(service: AutomationRuntimeService) {
  return buildSavedAutomationCatalogEntries(service.listWorkflows(), service.listTasks());
}

function cloneCatalogEntry(entry: SavedAutomationCatalogEntry): SavedAutomationCatalogEntry {
  return {
    ...entry,
    ...(entry.workflow ? { workflow: cloneWorkflow(entry.workflow) } : {}),
    ...(entry.task ? { task: cloneTask(entry.task) } : {}),
  };
}

function cloneCatalogTemplate(
  template: Pick<BuiltinTemplate, 'id' | 'category' | 'playbooks'> & { installed: boolean },
): Pick<BuiltinTemplate, 'id' | 'category' | 'playbooks'> & { installed: boolean } {
  return {
    ...template,
    playbooks: template.playbooks.map((playbook) => cloneWorkflow(playbook)),
  };
}

function cloneWorkflow(workflow: AssistantConnectorPlaybookDefinition): AssistantConnectorPlaybookDefinition {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step })),
    ...(workflow.outputHandling ? { outputHandling: { ...workflow.outputHandling } } : {}),
  };
}

function cloneTask(task: ScheduledTaskDefinition): ScheduledTaskDefinition {
  return {
    ...task,
    ...(task.args ? { args: { ...task.args } } : {}),
    ...(task.eventTrigger ? { eventTrigger: { ...task.eventTrigger } } : {}),
    ...(task.outputHandling ? { outputHandling: { ...task.outputHandling } } : {}),
  };
}

function cloneTaskCreateInput(input: ScheduledTaskCreateInput): ScheduledTaskCreateInput {
  return {
    ...input,
    ...(input.args ? { args: { ...input.args } } : {}),
    ...(input.eventTrigger ? { eventTrigger: { ...input.eventTrigger } } : {}),
    ...(input.outputHandling ? { outputHandling: { ...input.outputHandling } } : {}),
  };
}

function cloneTaskUpdateInput(input: ScheduledTaskUpdateInput): ScheduledTaskUpdateInput {
  return {
    ...input,
    ...(input.args ? { args: { ...input.args } } : {}),
    ...(input.eventTrigger ? { eventTrigger: { ...input.eventTrigger } } : {}),
    ...(input.outputHandling ? { outputHandling: { ...input.outputHandling } } : {}),
  };
}

function cloneTaskPreset(preset: ScheduledTaskPreset): ScheduledTaskPreset {
  return {
    ...preset,
    ...(preset.args ? { args: { ...preset.args } } : {}),
    ...(preset.eventTrigger ? { eventTrigger: { ...preset.eventTrigger } } : {}),
    ...(preset.outputHandling ? { outputHandling: { ...preset.outputHandling } } : {}),
  };
}

function cloneTaskHistoryEntry(entry: ScheduledTaskHistoryEntry): ScheduledTaskHistoryEntry {
  return {
    ...entry,
    ...(Array.isArray(entry.steps)
      ? {
          steps: entry.steps.map((step) => ({
            ...step,
            ...(isRecord(step.output) ? { output: { ...step.output } } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(entry.events)
      ? { events: entry.events.map((event) => ({ ...event })) }
      : {}),
    ...(isRecord(entry.output) ? { output: { ...entry.output } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
