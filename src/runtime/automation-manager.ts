import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { ScheduledTaskDefinition } from './scheduled-tasks.js';
import { buildSavedAutomationCatalogEntries, type SavedAutomationCatalogEntry } from './automation-catalog.js';

export interface AutomationManagerControlPlane {
  listWorkflows(): AssistantConnectorPlaybookDefinition[];
  listTasks(): ScheduledTaskDefinition[];
  upsertWorkflow(workflow: AssistantConnectorPlaybookDefinition): { success: boolean; message: string };
  updateTask(id: string, input: Record<string, unknown>): { success: boolean; message: string };
  deleteWorkflow(id: string): { success: boolean; message: string };
  deleteTask(id: string): { success: boolean; message: string };
  runWorkflow(input: {
    workflowId: string;
    dryRun?: boolean;
    origin?: 'assistant' | 'cli' | 'web';
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  }): Promise<unknown> | unknown;
  runTask(id: string): Promise<unknown> | unknown;
}

export function listSavedAutomations(controlPlane: AutomationManagerControlPlane): SavedAutomationCatalogEntry[] {
  return buildSavedAutomationCatalogEntries(
    controlPlane.listWorkflows().map(cloneWorkflow),
    controlPlane.listTasks().map(cloneTask),
  );
}

export function getSavedAutomationById(
  controlPlane: AutomationManagerControlPlane,
  automationId: string,
): SavedAutomationCatalogEntry | null {
  const normalized = automationId.trim();
  if (!normalized) return null;
  return listSavedAutomations(controlPlane).find((entry) => entry.id === normalized) ?? null;
}

export function setSavedAutomationEnabled(
  controlPlane: AutomationManagerControlPlane,
  automationId: string,
  enabled: boolean,
): { success: boolean; message: string } {
  const selected = getSavedAutomationById(controlPlane, automationId);
  if (!selected) {
    return { success: false, message: `Automation '${automationId}' not found.` };
  }

  if (selected.workflow) {
    return controlPlane.upsertWorkflow({
      ...cloneWorkflow(selected.workflow),
      enabled,
    });
  }

  if (!selected.task) {
    return { success: false, message: `Automation '${automationId}' is missing its task definition.` };
  }

  return controlPlane.updateTask(selected.task.id, { enabled });
}

export function deleteSavedAutomation(
  controlPlane: AutomationManagerControlPlane,
  automationId: string,
): { success: boolean; message: string } {
  const selected = getSavedAutomationById(controlPlane, automationId);
  if (!selected) {
    return { success: false, message: `Automation '${automationId}' not found.` };
  }

  const failures: string[] = [];
  if (selected.task) {
    const taskResult = controlPlane.deleteTask(selected.task.id);
    if (!taskResult.success) failures.push(taskResult.message || `Could not delete task '${selected.task.id}'.`);
  }
  if (selected.workflow) {
    const workflowResult = controlPlane.deleteWorkflow(selected.workflow.id);
    if (!workflowResult.success) failures.push(workflowResult.message || `Could not delete workflow '${selected.workflow.id}'.`);
  }

  if (failures.length > 0) {
    return { success: false, message: failures.join(' ') };
  }

  return { success: true, message: `Deleted '${selected.name}'.` };
}

export async function runSavedAutomation(
  controlPlane: AutomationManagerControlPlane,
  automationId: string,
  options?: {
    dryRun?: boolean;
    origin?: 'assistant' | 'cli' | 'web';
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  },
): Promise<Record<string, unknown>> {
  const selected = getSavedAutomationById(controlPlane, automationId);
  if (!selected) {
    return { success: false, message: `Automation '${automationId}' not found.` };
  }

  if (selected.workflow) {
    const result = await controlPlane.runWorkflow({
      workflowId: selected.workflow.id,
      ...options,
    });
    return isRecord(result)
      ? result
      : { success: false, message: 'Workflow run returned an invalid result.' };
  }

  if (!selected.task) {
    return { success: false, message: `Automation '${automationId}' is missing its task definition.` };
  }

  const result = await controlPlane.runTask(selected.task.id);
  return isRecord(result)
    ? result
    : { success: false, message: 'Task run returned an invalid result.' };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
