import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { ConnectorPlaybookRunInput, ConnectorPlaybookRunResult, PlaybookRunRecord } from './connectors.js';
import {
  createAutomationFromCatalogEntry,
  type AutomationCatalogCreateResult,
} from './automation-catalog-actions.js';
import {
  saveAutomationDefinition,
  type AutomationSaveInput,
  type AutomationSaveResult,
} from './automation-save.js';
import { buildAutomationRunHistoryEntries, type AutomationRunHistoryEntry } from './automation-run-history.js';
import {
  buildAutomationCatalogEntries,
  buildSavedAutomationCatalogEntries,
  type SavedAutomationCatalogEntry,
} from './automation-catalog.js';
import {
  buildAutomationCatalogViewEntries,
  type AutomationCatalogToolMetadata,
  type AutomationCatalogViewEntry,
} from './automation-catalog-view.js';
import type { BuiltinAutomationExample } from './builtin-packs.js';
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
  history(): PlaybookRunRecord[];
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
  createFromPresetExample(presetId: string): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  history(): ScheduledTaskHistoryEntry[];
}

interface AutomationTemplateControl {
  list(): Array<Pick<BuiltinAutomationExample, 'id' | 'category' | 'playbooks'> & { materialized: boolean }>;
  createFromExample?(templateId: string): { success: boolean; message: string };
}

export interface AutomationRuntimeServiceOptions {
  workflows: AutomationWorkflowControl;
  tasks: AutomationTaskControl;
  templates?: AutomationTemplateControl;
  toolMetadata?: AutomationCatalogToolMetadata[];
  onWorkflowSaved?: (playbook: AssistantConnectorPlaybookDefinition) => void;
  onWorkflowRunResult?: (
    result: ConnectorPlaybookRunResult,
    input: ConnectorPlaybookRunInput,
  ) => Promise<void> | void;
}

export interface AutomationRuntimeService {
  listAutomationCatalog(): SavedAutomationCatalogEntry[];
  listAutomationCatalogView(): AutomationCatalogViewEntry[];
  listAutomationRunHistory(): AutomationRunHistoryEntry[];
  createAutomationFromCatalog(automationId: string): AutomationCatalogCreateResult;
  saveAutomation(input: AutomationSaveInput): AutomationSaveResult;
  saveAutomationDefinition(
    automationId: string,
    workflow: AssistantConnectorPlaybookDefinition,
  ): AutomationSaveResult;
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
  createAutomationFromPresetExample(presetId: string): { success: boolean; message: string; task?: ScheduledTaskDefinition };
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
    saveAutomation: (input: AutomationSaveInput) => AutomationSaveResult;
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
  const toolMetadata = (options.toolMetadata ?? []).map((tool) => ({ ...tool }));
  const service: AutomationRuntimeService = {
    listAutomationCatalog: () => buildAutomationCatalogEntries(
      service.listWorkflows(),
      service.listTasks(),
      options.templates?.list().map(cloneCatalogTemplate) ?? [],
      service.listTaskPresets(),
    ),
    listAutomationCatalogView: () => buildAutomationCatalogViewEntries(service.listAutomationCatalog(), toolMetadata),
    listAutomationRunHistory: () => buildAutomationRunHistoryEntries(
      options.workflows.history().map(cloneWorkflowRun),
      service.listTaskHistory(),
    ),
    createAutomationFromCatalog: (automationId) => {
      const createFromExample = options.templates?.createFromExample;
      const controlPlane = {
        listCatalog: () => service.listAutomationCatalog(),
        upsertWorkflow: (workflow: AssistantConnectorPlaybookDefinition) => service.upsertWorkflow(workflow),
        deleteWorkflow: (workflowId: string) => service.deleteWorkflow(workflowId),
        createTask: (input: ScheduledTaskCreateInput) => service.createTask(input),
        createFromPresetExample: (presetId: string) => service.createAutomationFromPresetExample(presetId),
        ...(createFromExample
          ? { createFromTemplateExample: (templateId: string) => createFromExample(templateId) }
          : {}),
      };
      return createAutomationFromCatalogEntry(controlPlane, automationId);
    },
    saveAutomation: (input) => saveAutomationDefinition({
      upsertWorkflow: (workflow: AssistantConnectorPlaybookDefinition) => service.upsertWorkflow(workflow),
      createTask: (taskInput: ScheduledTaskCreateInput) => service.createTask(taskInput),
      updateTask: (taskId: string, taskInput: ScheduledTaskUpdateInput) => service.updateTask(taskId, taskInput),
      deleteTask: (taskId: string) => service.deleteTask(taskId),
    }, prepareAutomationSaveInput(service, input)),
    saveAutomationDefinition: (automationId, workflow) => {
      const existing = findAutomationCatalogViewEntry(service, automationId);
      if (!existing) {
        return { success: false, message: `Automation '${automationId}' was not found.` };
      }
      if (existing.builtin) {
        return {
          success: false,
          message: 'Create a copy of this starter example before editing its raw definition.',
        };
      }
      if (!existing.workflow) {
        return {
          success: false,
          message: 'Only step-based automations support raw definition editing.',
        };
      }

      const normalized = normalizeWorkflowDefinitionForAutomation(existing, workflow);
      if (!normalized.success) {
        return { success: false, message: normalized.message };
      }

      const workflowResult = service.upsertWorkflow(normalized.workflow);
      if (!workflowResult.success) {
        return {
          success: false,
          message: workflowResult.message || 'Failed to save the automation definition.',
        };
      }

      const linkedTaskId = existing.task?.type === 'playbook' ? existing.task.id : undefined;
      if (!linkedTaskId) {
        return {
          success: true,
          automationId: normalized.workflow.id,
          message: workflowResult.message || 'Saved.',
        };
      }

      const taskResult = service.updateTask(linkedTaskId, {
        name: normalized.workflow.name,
        outputHandling: normalized.workflow.outputHandling,
      });
      if (!taskResult.success) {
        return {
          success: false,
          automationId: normalized.workflow.id,
          taskId: linkedTaskId,
          message: `Workflow definition saved, but the linked schedule could not be updated: ${taskResult.message || 'Unknown error.'}`,
        };
      }
      return {
        success: true,
        automationId: normalized.workflow.id,
        taskId: linkedTaskId,
        message: workflowResult.message || 'Saved.',
      };
    },
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
    createAutomationFromPresetExample: (presetId) => options.tasks.createFromPresetExample(presetId),
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
      saveAutomation: (input) => service.saveAutomation(input),
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
  template: Pick<BuiltinAutomationExample, 'id' | 'category' | 'playbooks'> & { materialized: boolean },
): Pick<BuiltinAutomationExample, 'id' | 'category' | 'playbooks'> & { materialized: boolean } {
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
  const cloned: ScheduledTaskUpdateInput = {
    ...input,
    ...(input.args ? { args: { ...input.args } } : {}),
    ...(input.eventTrigger ? { eventTrigger: { ...input.eventTrigger } } : {}),
  };
  if (Object.prototype.hasOwnProperty.call(input, 'outputHandling')) {
    cloned.outputHandling = input.outputHandling ? { ...input.outputHandling } : undefined;
  }
  return cloned;
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

function cloneWorkflowRun(run: PlaybookRunRecord): PlaybookRunRecord {
  return {
    ...run,
    steps: run.steps.map((step) => ({
      ...step,
      ...(isRecord(step.output) ? { output: { ...step.output } } : {}),
    })),
    ...(run.outputHandling ? { outputHandling: { ...run.outputHandling } } : {}),
    ...(Array.isArray(run.promotedFindings)
      ? { promotedFindings: run.promotedFindings.map((finding) => ({ ...finding })) }
      : {}),
    ...(Array.isArray(run.events) ? { events: run.events.map((event) => ({ ...event })) } : { events: [] }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findAutomationCatalogViewEntry(
  service: AutomationRuntimeService,
  automationId: string,
): AutomationCatalogViewEntry | null {
  const normalizedId = automationId.trim();
  if (!normalizedId) return null;
  return service.listAutomationCatalogView().find((entry) => entry.id === normalizedId) ?? null;
}

function prepareAutomationSaveInput(
  service: AutomationRuntimeService,
  input: AutomationSaveInput,
): AutomationSaveInput {
  const normalized: AutomationSaveInput = {
    ...input,
    ...(Array.isArray(input.steps) ? { steps: input.steps.map((step) => ({ ...step })) } : {}),
    ...(input.task
      ? {
          task: {
            ...input.task,
            ...(input.task.args ? { args: { ...input.task.args } } : {}),
          },
        }
      : {}),
    ...(input.schedule ? { schedule: { ...input.schedule } } : {}),
    ...(input.outputHandling ? { outputHandling: { ...input.outputHandling } } : {}),
  };
  if (normalized.kind !== 'workflow' || Object.prototype.hasOwnProperty.call(input, 'signature')) {
    return normalized;
  }

  const existing = findAutomationCatalogViewEntry(service, normalized.id);
  if (!existing?.workflow?.signature) {
    return normalized;
  }
  normalized.signature = existing.workflow.signature;
  return normalized;
}

function normalizeWorkflowDefinitionForAutomation(
  existing: AutomationCatalogViewEntry,
  workflow: AssistantConnectorPlaybookDefinition,
): { success: true; workflow: AssistantConnectorPlaybookDefinition } | { success: false; message: string } {
  const existingId = existing.workflow?.id || existing.id;
  const requestedId = typeof workflow.id === 'string' ? workflow.id.trim() : '';
  if (!requestedId) {
    return { success: false, message: 'Automation ID is required.' };
  }
  if (requestedId !== existingId) {
    return {
      success: false,
      message: 'Raw definition editing cannot rename an automation. Use Create Copy or the structured editor instead.',
    };
  }

  const name = typeof workflow.name === 'string' ? workflow.name.trim() : '';
  if (!name) {
    return { success: false, message: 'Automation name is required.' };
  }
  if (workflow.mode !== 'parallel' && workflow.mode !== 'sequential') {
    return { success: false, message: 'Automation mode must be sequential or parallel.' };
  }

  const steps = Array.isArray(workflow.steps)
    ? workflow.steps.map((step) => ({ ...step }))
    : [];
  if (steps.length === 0) {
    return { success: false, message: 'Add at least one workflow step.' };
  }

  return {
    success: true,
    workflow: {
      id: existingId,
      name,
      enabled: workflow.enabled !== false,
      mode: workflow.mode,
      ...(workflow.description?.trim() ? { description: workflow.description.trim() } : {}),
      ...(workflow.signature?.trim() ? { signature: workflow.signature.trim() } : {}),
      ...(workflow.outputHandling ? { outputHandling: { ...workflow.outputHandling } } : {}),
      steps,
    },
  };
}
