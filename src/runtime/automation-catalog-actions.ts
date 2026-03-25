import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { SavedAutomationCatalogEntry } from './automation-catalog.js';
import type {
  ScheduledTaskCreateInput,
  ScheduledTaskDefinition,
} from './scheduled-tasks.js';

export interface AutomationCatalogActionControlPlane {
  listCatalog(): SavedAutomationCatalogEntry[];
  upsertWorkflow(workflow: AssistantConnectorPlaybookDefinition): { success: boolean; message: string };
  deleteWorkflow(workflowId: string): { success: boolean; message: string };
  createTask(input: ScheduledTaskCreateInput): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  installPreset(presetId: string): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  installTemplate?(templateId: string): { success: boolean; message: string };
}

export interface AutomationCatalogCreateResult {
  success: boolean;
  message: string;
  action?: 'created' | 'copied';
  automationId?: string;
  automationName?: string;
}

export function createAutomationFromCatalogEntry(
  controlPlane: AutomationCatalogActionControlPlane,
  automationId: string,
): AutomationCatalogCreateResult {
  const selected = getCatalogEntry(controlPlane, automationId);
  if (!selected) {
    return { success: false, message: `Automation '${automationId}' not found.` };
  }

  if (selected.source === 'builtin_template' || selected.source === 'builtin_preset' || selected.builtin === true) {
    return createAutomationFromBuiltinExample(controlPlane, selected);
  }

  return cloneSavedCatalogEntry(controlPlane, selected);
}

function getCatalogEntry(
  controlPlane: AutomationCatalogActionControlPlane,
  automationId: string,
): SavedAutomationCatalogEntry | null {
  const normalized = automationId.trim();
  if (!normalized) return null;
  return controlPlane.listCatalog().find((entry) => entry.id === normalized) ?? null;
}

function createAutomationFromBuiltinExample(
  controlPlane: AutomationCatalogActionControlPlane,
  entry: SavedAutomationCatalogEntry,
): AutomationCatalogCreateResult {
  if (entry.source === 'builtin_template') {
    if (!entry.templateId?.trim()) {
      return { success: false, message: `Built-in automation '${entry.name}' is missing its template reference.` };
    }
    if (!controlPlane.installTemplate) {
      return { success: false, message: 'Creating an automation from this starter example is not available.' };
    }
    const result = controlPlane.installTemplate(entry.templateId);
    const automationName = entry.workflow?.name || entry.name;
    const automationId = entry.workflow?.id || entry.id;
    return {
      success: result.success,
      message: result.success
        ? `Created automation '${automationName}' from the starter example.`
        : (result.message || `Could not create '${entry.name}' from the starter example.`),
      action: result.success ? 'created' : undefined,
      automationId: result.success ? automationId : undefined,
      automationName: result.success ? automationName : undefined,
    };
  }

  if (!entry.presetId?.trim()) {
    return { success: false, message: `Built-in automation '${entry.name}' is missing its preset reference.` };
  }
  const result = controlPlane.installPreset(entry.presetId);
  const automationName = result.task?.name || entry.name;
  return {
    success: result.success,
    message: result.success
      ? `Created automation '${automationName}' from the starter example.`
      : (result.message || `Could not create '${entry.name}' from the starter example.`),
    action: result.success ? 'created' : undefined,
    automationId: result.task?.id,
    automationName: result.success ? automationName : undefined,
  };
}

function cloneSavedCatalogEntry(
  controlPlane: AutomationCatalogActionControlPlane,
  entry: SavedAutomationCatalogEntry,
): AutomationCatalogCreateResult {
  const catalog = controlPlane.listCatalog();
  const cloneName = buildCloneName(entry.name, catalog);

  if (entry.workflow) {
    return cloneWorkflowEntry(controlPlane, entry, cloneName, catalog);
  }

  if (!entry.task) {
    return { success: false, message: `Automation '${entry.name}' cannot be cloned.` };
  }

  const taskResult = controlPlane.createTask(buildTaskCloneInput(entry.task, cloneName));
  return {
    success: taskResult.success,
    message: taskResult.success
      ? `Created copy '${taskResult.task?.name || cloneName}' from '${entry.name}'.`
      : taskResult.message || `Could not clone '${entry.name}'.`,
    action: taskResult.success ? 'copied' : undefined,
    automationId: taskResult.task?.id,
    automationName: taskResult.task?.name || cloneName,
  };
}

function cloneWorkflowEntry(
  controlPlane: AutomationCatalogActionControlPlane,
  entry: SavedAutomationCatalogEntry,
  cloneName: string,
  catalog: SavedAutomationCatalogEntry[],
): AutomationCatalogCreateResult {
  const sourceWorkflow = entry.workflow;
  if (!sourceWorkflow) {
    return { success: false, message: `Automation '${entry.name}' cannot be cloned.` };
  }
  const cloneId = buildCloneWorkflowId(sourceWorkflow.id || entry.id, catalog);
  const clonedWorkflow = cloneWorkflow(sourceWorkflow);
  const linkedPlaybookTask = entry.task?.type === 'playbook' ? entry.task : null;
  if (linkedPlaybookTask) {
    delete clonedWorkflow.schedule;
  }

  const workflowResult = controlPlane.upsertWorkflow({
    ...clonedWorkflow,
    id: cloneId,
    name: cloneName,
    enabled: false,
  });
  if (!workflowResult.success) {
    return {
      success: false,
      message: workflowResult.message || `Could not clone '${entry.name}'.`,
    };
  }

  if (linkedPlaybookTask) {
    const taskResult = controlPlane.createTask(buildTaskCloneInput(linkedPlaybookTask, cloneName, cloneId));
    if (!taskResult.success) {
      const rollback = controlPlane.deleteWorkflow(cloneId);
      const rollbackMessage = rollback.success
        ? ''
        : ` Rollback failed: ${rollback.message || `Could not delete '${cloneId}'.`}`;
      return {
        success: false,
        message: `${taskResult.message || `Could not clone '${entry.name}'.`}${rollbackMessage}`,
      };
    }
  }

  return {
    success: true,
    message: `Created copy '${cloneName}' from '${entry.name}'.`,
    action: 'copied',
    automationId: cloneId,
    automationName: cloneName,
  };
}

function buildCloneName(
  baseName: string,
  catalog: SavedAutomationCatalogEntry[],
): string {
  const existing = new Set(catalog.map((entry) => normalizeLookupKey(entry.name)));
  const stem = baseName.trim() || 'Automation';
  let index = 1;
  while (true) {
    const candidate = index === 1 ? `${stem} (copy)` : `${stem} (copy ${index})`;
    if (!existing.has(normalizeLookupKey(candidate))) {
      return candidate;
    }
    index += 1;
  }
}

function buildCloneWorkflowId(
  sourceId: string,
  catalog: SavedAutomationCatalogEntry[],
): string {
  const existing = new Set(catalog.map((entry) => entry.id.trim()).filter(Boolean));
  const stem = slugify(sourceId) || 'automation';
  let index = 1;
  while (true) {
    const candidate = index === 1 ? `${stem}-copy` : `${stem}-copy-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function buildTaskCloneInput(
  task: ScheduledTaskDefinition,
  name: string,
  workflowTarget?: string,
): ScheduledTaskCreateInput {
  const eventTrigger = cloneEventTrigger(task);
  return {
    name,
    ...(task.description ? { description: task.description } : {}),
    type: workflowTarget ? 'playbook' : task.type,
    target: workflowTarget || task.target,
    ...(task.args ? { args: { ...task.args } } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(task.channel ? { channel: task.channel } : {}),
    ...(task.userId ? { userId: task.userId } : {}),
    ...(task.principalId ? { principalId: task.principalId } : {}),
    ...(task.principalRole ? { principalRole: task.principalRole } : {}),
    ...(typeof task.deliver === 'boolean' ? { deliver: task.deliver } : {}),
    ...(task.runOnce === true ? { runOnce: true } : {}),
    ...(task.cron ? { cron: task.cron } : {}),
    ...(eventTrigger ? { eventTrigger } : {}),
    enabled: false,
    ...(typeof task.maxRunsPerWindow === 'number' ? { maxRunsPerWindow: task.maxRunsPerWindow } : {}),
    ...(typeof task.dailySpendCap === 'number' ? { dailySpendCap: task.dailySpendCap } : {}),
    ...(typeof task.providerSpendCap === 'number' ? { providerSpendCap: task.providerSpendCap } : {}),
    ...(task.emitEvent ? { emitEvent: task.emitEvent } : {}),
    ...(task.outputHandling ? { outputHandling: { ...task.outputHandling } } : {}),
  };
}

function cloneEventTrigger(task: ScheduledTaskDefinition): ScheduledTaskDefinition['eventTrigger'] | undefined {
  if (!task.eventTrigger) return undefined;
  if (task.eventTrigger.eventType.startsWith('automation:manual:')) {
    return undefined;
  }
  return {
    ...task.eventTrigger,
    ...(task.eventTrigger.match ? { match: { ...task.eventTrigger.match } } : {}),
  };
}

function cloneWorkflow(workflow: AssistantConnectorPlaybookDefinition): AssistantConnectorPlaybookDefinition {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step })),
    ...(workflow.outputHandling ? { outputHandling: { ...workflow.outputHandling } } : {}),
  };
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
